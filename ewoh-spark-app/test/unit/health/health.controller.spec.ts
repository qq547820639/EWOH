import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../../server/modules/health/health.controller';
import { ReplanGuardStatusService } from '../../../server/modules/health/replan-guard-status.service';

/** NEST-437：带凭证（authorization/userContext）才返回完整 checks。 */
const authenticatedRequest = {
  headers: { authorization: 'Bearer healthz-token' },
} as never;

describe('HealthController', () => {
  it('reports liveness without touching the database', () => {
    const execute = jest.fn();
    const controller = new HealthController({ execute } as never);

    expect(controller.live()).toEqual({ status: 'ok', service: 'ewoh-api' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('NEST-437: anonymous probe gets {status} only (no internal checks detail)', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
    });
    await expect(controller.ready({} as never)).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
    });
  });

  it('reports readiness with full checks after a successful database query (authenticated)', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready(authenticatedRequest)).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
      checks: { database: 'ok' },
    });
  });

  it('returns unavailable when the database query fails', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('offline'));
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.ready(authenticatedRequest)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  /**
   * CFG-01b（V65）：探活必须在**显式系统事务**里读库。
   * `EWOH_DB_REQUIRE_TX=1` 下，"HTTP 请求上下文内但无事务 store"的根句柄回落会抛错，
   * 而 `/health/ready` 是 `@Public`（身份之前，OrgContextInterceptor 不建事务）——
   * 不开系统事务就等于让开了推荐开关的应用永远无法就绪。
   */
  it('CFG-01b: readiness probe goes through an explicit system transaction', async () => {
    // 注：`this.db` 在生产里是 RequestDatabaseContext 的代理——事务 store 由
    // systemTransaction 通过 ALS 建立，代理自己会解析到该事务句柄。单测只判
    // "有没有开系统事务"，代理解析语义由 request-database-context 自己的用例覆盖。
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    let inTransaction = false;
    const systemTransaction = jest.fn(async (op: () => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await op();
      } finally {
        inTransaction = false;
      }
    });
    const controller = new HealthController({ execute } as never, undefined, undefined, {
      systemTransaction,
    } as never);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
    });
    expect(systemTransaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    // 探针结束事务必须退出（不能把请求级事务留在场）。
    expect(inTransaction).toBe(false);
  });

  it('CFG-01b: probes still work without the context (legacy wiring / test doubles)', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready(authenticatedRequest)).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
      checks: { database: 'ok' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('CFG-01b: readiness failure keeps the underlying cause in the log (not swallowed)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const execute = jest
      .fn()
      .mockRejectedValue(new Error('RequestDatabaseContext: HTTP 请求路径必须经 runInTransaction'));
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready(authenticatedRequest)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('必须经 runInTransaction');
    errorSpy.mockRestore();
  });

  it('reports scheduler.replanGuard ok when no guard degradation was recorded', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const guardStatus = new ReplanGuardStatusService();
    const controller = new HealthController({ execute } as never, undefined, guardStatus);

    await expect(controller.ready(authenticatedRequest)).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
      checks: { database: 'ok', scheduler: { replanGuard: 'ok' } },
    });
  });

  it('reports degraded readiness with reason when the replan guard degraded recently', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const guardStatus = new ReplanGuardStatusService();
    guardStatus.recordDegradation('advisory lock unavailable (test)');
    const controller = new HealthController({ execute } as never, undefined, guardStatus);

    await expect(controller.ready(authenticatedRequest)).resolves.toEqual({
      status: 'degraded',
      service: 'ewoh-api',
      checks: {
        database: 'ok',
        scheduler: {
          replanGuard: 'degraded',
          reason: 'advisory lock unavailable (test)',
          lastDegradationAt: expect.any(String),
        },
      },
    });
  });
});
