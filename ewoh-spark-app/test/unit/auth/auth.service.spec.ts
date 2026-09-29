import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { AuthService } from '../../../server/modules/auth/auth.service';

const JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';

describe('standalone JWT auth', () => {
  let passwordHash: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    passwordHash = await bcrypt.hash('correct-password', 4);
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  function createService(overrides?: { rows?: Array<Record<string, unknown>>; error?: Error }) {
    const rows = overrides?.rows ?? [
      {
        username: 'admin',
        password_hash: passwordHash,
        org_id: 'f3bdfae3-88d0-49f7-9088-fd7b8df80b8c',
        roles: ['operator'],
        is_global_admin: true,
      },
    ];
    const execute = overrides?.error
      ? jest.fn().mockRejectedValue(overrides.error)
      : jest.fn().mockResolvedValue(rows);
    return { service: new AuthService({ execute } as never), execute };
  }

  /**
   * CFG-01（2026-09-22 链行为基线 §5.4）：`EWOH_DB_REQUIRE_TX=1` 是注释里写着
   * "生产建议开启"的租户隔离兜底，但登录发生在身份/租户上下文建立之前，
   * 请求没有被包进事务 ⇒ 兜底一开就把整条链打在 503 上（实测 D 段 10/10 红）。
   * 修法不是给路由开后门，而是给这条读一个**显式系统事务**。
   */
  const userRow = () => [
    {
      username: 'admin',
      password_hash: passwordHash,
      org_id: 'f3bdfae3-88d0-49f7-9088-fd7b8df80b8c',
      roles: ['operator'],
      is_global_admin: true,
    },
  ];

  it('CFG-01：登录读必须走显式系统事务（而不是在请求上下文里回落根句柄）', async () => {
    const execute = jest.fn().mockResolvedValue(userRow());
    const systemTransaction = jest.fn((op: () => Promise<unknown>) => op());
    const service = new AuthService(
      { execute } as never,
      undefined,
      { systemTransaction } as never,
    );

    const tokens = await service.login('admin', 'correct-password');

    expect(tokens.user.userId).toBe('admin');
    expect(systemTransaction).toHaveBeenCalledTimes(1);
  });

  /** 未注入上下文（单测/旧装配）时退回原句柄行为——不能因为兜底改造而拒绝服务。 */
  it('CFG-01 对照：无 RequestDatabaseContext 时仍按原路径查库', async () => {
    const execute = jest.fn().mockResolvedValue(userRow());
    const service = new AuthService({ execute } as never);

    await expect(service.login('admin', 'correct-password')).resolves.toBeTruthy();
    expect(execute).toHaveBeenCalled();
  });

  /**
   * 同一处的第二半：裸 catch 会把兜底抛错改写成「Authentication store is unavailable」，
   * 运维面看到的就是"数据库故障"。HTTP 契约保持 503，但**成因必须留在日志里**。
   */
  it('CFG-01：fail-closed 的成因必须留痕，不能只报"存储不可用"', async () => {
    const service = new AuthService(
      { execute: jest.fn() } as never,
      undefined,
      {
        systemTransaction: jest.fn(() =>
          Promise.reject(
            new Error('RequestDatabaseContext: HTTP 请求路径必须经 runInTransaction（fail-closed）'),
          ),
        ),
      } as never,
    );
    const logged: string[] = [];
    (service as unknown as {
      logger: { error: (m: string) => void };
    }).logger = {
      error: (m: string) => {
        logged.push(m);
      },
    };

    await expect(service.login('admin', 'correct-password')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logged.join(' ')).toContain('必须经 runInTransaction');
  });

  it('accepts a bcrypt password and rejects an incorrect password', async () => {
    const { service } = createService();

    await expect(service.login('admin', 'wrong-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const tokens = await service.login('admin', 'correct-password');

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.user.roles).toEqual(['operator', 'global_admin']);
  });

  it('rejects an unknown user', async () => {
    const { service } = createService({ rows: [] });

    await expect(service.login('missing', 'correct-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when the authentication store is unavailable', async () => {
    const { service } = createService({ error: new Error('database offline') });

    await expect(service.login('admin', 'correct-password')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refreshes with a refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    const refreshed = await service.refresh(tokens.refreshToken);

    expect((await service.verifyToken(refreshed.accessToken)).sub).toBe('admin');
  });

  it('rotates refresh tokens and invalidates the previous jti', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    const refreshed = await service.refresh(tokens.refreshToken);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

    await expect(service.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const second = await service.refresh(refreshed.refreshToken);
    expect((await service.verifyToken(second.accessToken)).sub).toBe('admin');
  });

  it('logout revokes the current refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    await service.logout(tokens.refreshToken);
    await expect(service.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logout revokes the presented access token (NEST-418)', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    // 登出同时吊销 access（jti 黑名单），token 未过期也不再可用。
    await service.logout(tokens.refreshToken, tokens.accessToken);
    await expect(service.verifyToken(tokens.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('deactivated users keep no working tokens (NEST-418 R2)', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    // 停用后 ewoh_find_active_user 不再返回该用户 → 存量 token 立即失效。
    const deactivated = new AuthService({
      execute: jest.fn().mockResolvedValue([]),
    } as never);
    await expect(deactivated.verifyToken(tokens.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // 用户仍 active 的实例 → 同一 token 正常通过。
    await expect(service.verifyToken(tokens.accessToken)).resolves.toMatchObject({
      sub: 'admin',
    });
  });

  it('does not accept an access token as a refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    await expect(service.refresh(tokens.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not accept a refresh token as an access token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    await expect(service.verifyToken(tokens.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a signed access token with an incomplete payload', async () => {
    const { service } = createService();
    const malformed = sign({ sub: 'admin', type: 'access' }, JWT_SECRET, {
      algorithm: 'HS256',
    });

    await expect(service.verifyToken(malformed)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a legacy access token without a revocable jti', async () => {
    const { service } = createService();
    const legacy = sign(
      {
        sub: 'admin',
        type: 'access',
        username: 'admin',
        orgId: 'f3bdfae3-88d0-49f7-9088-fd7b8df80b8c',
        roles: ['operator'],
      },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );

    await expect(service.verifyToken(legacy)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
