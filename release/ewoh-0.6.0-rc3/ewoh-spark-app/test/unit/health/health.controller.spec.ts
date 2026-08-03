import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../../server/modules/health/health.controller';

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
});
