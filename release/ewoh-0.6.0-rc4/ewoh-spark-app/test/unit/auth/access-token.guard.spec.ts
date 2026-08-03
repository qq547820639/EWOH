import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard } from '../../../server/modules/shared/access-token.guard';
import { IS_PUBLIC_KEY } from '../../../server/modules/shared/public.decorator';

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
