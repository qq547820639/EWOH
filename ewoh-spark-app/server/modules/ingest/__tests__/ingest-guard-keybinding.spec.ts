/// <reference types="jest" />
/* R2-SOP-004 回归：IngestGuard 的 key→org 绑定信任边界。
 * - per-key 绑定（INGEST_API_KEY_<ORG> / INGEST_API_KEYS JSON）：org 以绑定为准，
 *   自报 X-Org-Id 越出绑定域 → 403；
 * - legacy 兼容：全局 INGEST_API_KEY 无绑定时仍接受 X-Org-Id（warn 迁移提示）；
 * - 未知 key → 401；无任何 org 可解析 → 401。 */
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { IngestGuard } from '../ingest.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  const request = {
    headers,
    ip: '203.0.113.10',
    socket: { remoteAddress: '203.0.113.10' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard(): IngestGuard {
  // 限流 stub：单 IP 计数恒为 1（不触 429），不依赖 Redis。
  return new IngestGuard({ incr: async () => 1 } as never);
}

const ENV_KEYS = [
  'INGEST_API_KEY',
  'INGEST_API_KEYS',
  'INGEST_API_KEY_MAP',
  'INGEST_API_KEY_ORG_A',
  'EWOH_INGEST_ORG_ID',
  'INGEST_INSECURE_DEV_MODE',
] as const;

describe('R2-SOP-004: IngestGuard per-key org 绑定', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  function userContextOf(value: { canActivate(c: ExecutionContext): Promise<boolean> }, c: ExecutionContext) {
    return (c.switchToHttp().getRequest() as { userContext?: { primaryOrgId: string } })
      .userContext;
  }

  it('per-key 环境变量绑定：key 命中 → org 以绑定为准（无 X-Org-Id 也可）', async () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    const guard = makeGuard();
    const ctx = makeContext({ 'x-ingest-key': 'key-org-a' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userContextOf(guard, ctx)?.primaryOrgId).toBe('ORG_A');
  });

  it('per-key 绑定 + 匹配的 X-Org-Id（大小写不敏感）→ 通过', async () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    const guard = makeGuard();
    const ctx = makeContext({ 'x-ingest-key': 'key-org-a', 'x-org-id': 'org_a' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userContextOf(guard, ctx)?.primaryOrgId).toBe('ORG_A');
  });

  it('per-key 绑定 + 越域 X-Org-Id → 403 INGEST_ORG_MISMATCH（不再客户端自报）', async () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    const guard = makeGuard();
    await expect(
      guard.canActivate(
        makeContext({ 'x-ingest-key': 'key-org-a', 'x-org-id': 'org-victim' }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'INGEST_ORG_MISMATCH' },
    });
  });

  it('INGEST_API_KEYS JSON 映射：key→org 绑定生效，越域头拒绝', async () => {
    process.env.INGEST_API_KEYS = JSON.stringify({ 'key-json': 'org-json' });
    const guard = makeGuard();
    const ctx = makeContext({ 'x-ingest-key': 'key-json' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userContextOf(guard, ctx)?.primaryOrgId).toBe('org-json');

    const guard2 = makeGuard();
    await expect(
      guard2.canActivate(
        makeContext({ 'x-ingest-key': 'key-json', 'x-org-id': 'org-other' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('legacy 无绑定 key：X-Org-Id 仍被接受（向后兼容），org 取自报头', async () => {
    process.env.INGEST_API_KEY = 'legacy-key';
    const guard = makeGuard();
    const ctx = makeContext({ 'x-ingest-key': 'legacy-key', 'x-org-id': 'org-legacy' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userContextOf(guard, ctx)?.primaryOrgId).toBe('org-legacy');
  });

  it('legacy key + EWOH_INGEST_ORG_ID 绑定：以绑定为 org，越域头拒绝', async () => {
    process.env.INGEST_API_KEY = 'legacy-key';
    process.env.EWOH_INGEST_ORG_ID = 'org-bound';
    const guard = makeGuard();
    const ctx = makeContext({ 'x-ingest-key': 'legacy-key' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userContextOf(guard, ctx)?.primaryOrgId).toBe('org-bound');

    const guard2 = makeGuard();
    await expect(
      guard2.canActivate(
        makeContext({ 'x-ingest-key': 'legacy-key', 'x-org-id': 'org-other' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('未知 key → 401', async () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    const guard = makeGuard();
    await expect(
      guard.canActivate(makeContext({ 'x-ingest-key': 'wrong-key', 'x-org-id': 'ORG_A' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('无绑定解析出 org（key 对但无 X-Org-Id/全局默认）→ 401', async () => {
    process.env.INGEST_API_KEY = 'legacy-key';
    const guard = makeGuard();
    await expect(
      guard.canActivate(makeContext({ 'x-ingest-key': 'legacy-key' })),
    ).rejects.toThrow(HttpException);
  });
});
