import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard } from '../../../server/modules/shared/access-token.guard';
import { IS_PUBLIC_KEY } from '../../../server/modules/shared/public.decorator';
import { OrgScopeHierarchyCycleError } from '../../../server/modules/shared/org-scope.service';

describe('AccessTokenGuard', () => {
  function createContext(request: { headers?: { authorization?: string }; userContext?: unknown }) {
    const handler = () => undefined;
    const controller = class TestController {};
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, handler };
  }

  function createOrgScope(orgIds: string[]) {
    return {
      resolveOrgScope: jest.fn().mockResolvedValue({ orgIds }),
    };
  }

  /**
   * AUTH-02（V189，§5.3em）：systemTransaction 间谍。守卫期的 org 层级解析先于
   * 请求上下文（TracingInterceptor）与请求事务（OrgContextInterceptor）建立，
   * `EWOH_DB_REQUIRE_TX=1` 的 fail-closed 对它结构性不可见——收口是把这条身份前
   * 系统读显式包进系统事务（V61 登录读 / V65 就绪探针同款）。
   * 下面的 G-TX 用例就是"读走了显式系统事务"的常驻判据：把守卫里的包装退回
   * 直接调用 ⇒ `fn` 调用数为 0 ⇒ 判据红（变异对照已实测）。
   */
  function createSystemTxSpy() {
    const fn = jest.fn(<T>(op: (db: never) => Promise<T>): Promise<T> => op(null as never));
    return { systemTransaction: fn as unknown, fn };
  }

  it('allows routes marked public without a token', async () => {
    const reflector = new Reflector();
    const authService = { verifyToken: jest.fn() };
    const guard = new AccessTokenGuard(reflector, authService as never);
    const { context, handler } = createContext({});
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects a protected route without a bearer token', async () => {
    const guard = new AccessTokenGuard(new Reflector(), { verifyToken: jest.fn() } as never);
    const { context } = createContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('verifies the access token and attaches the trusted user context', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        username: 'operator',
        orgId: 'org-a',
        roles: ['operator', 'global_admin'],
        type: 'access',
      }),
    };
    const orgScope = createOrgScope(['org-a']);
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.verifyToken).toHaveBeenCalledWith('signed-token');
    expect(orgScope.resolveOrgScope).toHaveBeenCalledWith('org-a');
    expect(request).toMatchObject({
      userContext: {
        userId: 'user-1',
        primaryOrgId: 'org-a',
        roles: ['operator', 'global_admin'],
        accessibleOrgIds: ['org-a'],
        isGlobalAdmin: true,
      },
    });
  });

  it('resolves parent/child/grandchild org ids into userContext', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        orgId: 'org-root',
        roles: ['viewer'],
        type: 'access',
      }),
    };
    const orgScope = createOrgScope(['org-root', 'org-child', 'org-grandchild']);
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.userContext).toMatchObject({
      primaryOrgId: 'org-root',
      accessibleOrgIds: ['org-root', 'org-child', 'org-grandchild'],
    });
  });

  it('G-TX resolves org scope via an explicit system transaction (AUTH-02)', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        orgId: 'org-root',
        roles: ['viewer'],
        type: 'access',
      }),
    };
    const orgScope = createOrgScope(['org-root', 'org-child']);
    const tx = createSystemTxSpy();
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
      tx as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    // 变异对照：守卫退回直接调用 resolveOrgScope ⇒ 调用数为 0 ⇒ 本判据红。
    expect(tx.fn).toHaveBeenCalledTimes(1);
    expect(orgScope.resolveOrgScope).toHaveBeenCalledWith('org-root');
    expect(request.userContext).toMatchObject({
      primaryOrgId: 'org-root',
      accessibleOrgIds: ['org-root', 'org-child'],
    });
  });

  it('falls back to the primary org when scope resolution fails', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        orgId: 'org-a',
        roles: ['viewer'],
        type: 'access',
      }),
    };
    const orgScope = {
      resolveOrgScope: jest.fn().mockRejectedValue(new Error('db unavailable')),
    };
    const tx = createSystemTxSpy();
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
      tx as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.userContext).toMatchObject({
      primaryOrgId: 'org-a',
      accessibleOrgIds: ['org-a'],
    });
  });

  it('rejects authentication when the organization hierarchy contains a cycle', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        orgId: 'org-a',
        roles: ['viewer'],
        type: 'access',
      }),
    };
    const orgScope = {
      resolveOrgScope: jest.fn().mockRejectedValue(
        new OrgScopeHierarchyCycleError(['org-a', 'org-b', 'org-a']),
      ),
    };
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(request.userContext).toBeUndefined();
  });

  it('keeps single-org behavior when the scope has no descendants', async () => {
    const authService = {
      verifyToken: jest.fn().mockReturnValue({
        sub: 'user-1',
        orgId: 'org-a',
        roles: ['viewer'],
        type: 'access',
      }),
    };
    const orgScope = createOrgScope(['org-a']);
    const guard = new AccessTokenGuard(
      new Reflector(),
      authService as never,
      orgScope as never,
    );
    const request: { headers?: { authorization?: string }; userContext?: unknown } = {
      headers: { authorization: 'Bearer signed-token' },
    };
    const { context } = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.userContext).toMatchObject({
      primaryOrgId: 'org-a',
      accessibleOrgIds: ['org-a'],
    });
  });
});
