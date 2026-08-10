import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../../server/modules/health/health.controller';
import { ReplanGuardStatusService } from '../../../server/modules/health/replan-guard-status.service';

describe('HealthController', () => {
  it('reports liveness without touching the database', () => {
    const execute = jest.fn();
    const controller = new HealthController({ execute } as never);

    expect(controller.live()).toEqual({ status: 'ok', service: 'ewoh-api' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports readiness after a successful database query', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      service: 'ewoh-api',
      checks: { database: 'ok' },
    });
  });

  it('returns unavailable when the database query fails', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('offline'));
    const controller = new HealthController({ execute } as never);

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports scheduler.replanGuard ok when no guard degradation was recorded', async () => {
    const execute = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const guardStatus = new ReplanGuardStatusService();
    const controller = new HealthController({ execute } as never, undefined, guardStatus);

    await expect(controller.ready()).resolves.toEqual({
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

    await expect(controller.ready()).resolves.toEqual({
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
