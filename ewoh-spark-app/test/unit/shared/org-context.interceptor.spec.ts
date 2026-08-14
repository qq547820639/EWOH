import {
  buildGucSettings,
  ORG_CONTEXT_GUC_ORDER,
  OrgContextInterceptor,
} from '../../../server/modules/shared/org-context.interceptor';
import { InternalServerErrorException } from '@nestjs/common';
import { lastValueFrom, of, take } from 'rxjs';

function httpContext(userContext?: unknown) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ userContext }),
    }),
  } as never;
}

function handlerReturning(value: unknown) {
  return { handle: jest.fn(() => of(value)) } as never;
}

/** 用 @Sse 同款元数据标记一个 handler（元数据挂在 descriptor.value 上），模拟 SSE 端点。 */
function sseHandlerContext(userContext: unknown) {
  const handler = function stream() {
    /* noop */
  };
  Reflect.defineMetadata('__sse__', true, handler);
  return Object.assign(httpContext(userContext), {
    getHandler: () => handler,
  }) as never;
}

describe('OrgContextInterceptor', () => {
  it('builds the GUC payload in the security contract order', () => {
    const settings = buildGucSettings({
      userId: 'user-1',
      primaryOrgId: 'org-root',
      role: 'dispatcher',
      accessibleOrgIds: ['org-root', 'org-child'],
      isGlobalAdmin: false,
    });

    expect(settings.map((setting) => setting.name)).toEqual([
      ...ORG_CONTEXT_GUC_ORDER,
    ]);
    expect(settings).toEqual([
      { name: 'app.user_id', value: 'user-1' },
      { name: 'app.current_org_id', value: 'org-root' },
      { name: 'app.current_org_ids', value: 'org-root,org-child' },
      { name: 'app.is_global_admin', value: 'false' },
    ]);
  });

  it('falls back to the primary org when accessible org ids are missing', () => {
    const settings = buildGucSettings({
      userId: 'user-1',
      primaryOrgId: 'org-root',
      isGlobalAdmin: true,
    });

    expect(settings[2]).toEqual({
      name: 'app.current_org_ids',
      value: 'org-root',
    });
    expect(settings[3]).toEqual({ name: 'app.is_global_admin', value: 'true' });
  });

  it('throws 500 when RequestDatabaseContext is missing instead of skipping GUCs', () => {
    const interceptor = new OrgContextInterceptor(undefined as never);
    expect(() =>
      interceptor.intercept(
        httpContext({ userId: 'user-1', primaryOrgId: 'org-root' }),
        handlerReturning('ok'),
      ),
    ).toThrow(InternalServerErrorException);
  });

  it('runs authenticated handlers inside the request transaction with GUC settings', async () => {
    const runInTransaction = jest.fn(
      async (_settings: unknown, operation: () => Promise<unknown>) =>
        operation(),
    );
    const interceptor = new OrgContextInterceptor({
      runInTransaction,
    } as never);
    const result = await lastValueFrom(
      interceptor.intercept(
        httpContext({ userId: 'user-1', primaryOrgId: 'org-root' }),
        handlerReturning('ok'),
      ),
    );

    expect(result).toBe('ok');
    expect(runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'app.user_id', value: 'user-1' },
        { name: 'app.current_org_id', value: 'org-root' },
      ]),
      expect.any(Function),
    );
  });

  it('passes through requests without userContext without opening a transaction', async () => {
    const runInTransaction = jest.fn();
    const interceptor = new OrgContextInterceptor({
      runInTransaction,
    } as never);
    const result = await lastValueFrom(
      interceptor.intercept(httpContext(undefined), handlerReturning('ok')),
    );

    expect(result).toBe('ok');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('passes SSE handlers straight through without lastValueFrom/transaction (P0: infinite stream never resolves)', async () => {
    const runInTransaction = jest.fn(
      async (_settings: unknown, operation: () => Promise<unknown>) =>
        operation(),
    );
    const interceptor = new OrgContextInterceptor({
      runInTransaction,
    } as never);
    const result = await lastValueFrom(
      interceptor
        .intercept(
          sseHandlerContext({ userId: 'user-1', primaryOrgId: 'org-root' }),
          { handle: jest.fn(() => of('event-a', 'event-b')) } as never,
        )
        .pipe(take(1)),
    );

    expect(result).toBe('event-a');
    expect(runInTransaction).not.toHaveBeenCalled();
  });
});
