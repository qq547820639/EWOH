import { UnauthorizedException } from '@nestjs/common';
import { SystemService, maskSensitiveConfig } from '../../../server/modules/system/system.service';
import { ewohSchedulerConfig } from '../../../server/database/schema';

describe('system config masking', () => {
  it('redacts credential-like keys and preserves safe values', () => {
    const masked = maskSensitiveConfig({
      weights: { output: 1 },
      apiToken: 'abc',
      notice: 'ok',
    }) as Record<string, unknown>;
    expect(masked.apiToken).toBe('[REDACTED]');
    expect(masked.notice).toBe('ok');
    expect((masked.weights as Record<string, unknown>).output).toBe(1);
  });
});

describe('SystemService upsert', () => {
  it('upserts by (orgId, configKey) and takes updatedBy from the authenticated user', async () => {
    const row = {
      id: 'config-1',
      configKey: 'weights',
      configValue: { output: 1 },
      updatedBy: 'user-1',
      createdAt: new Date('2026-08-03T00:00:00Z'),
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const returning = jest.fn().mockResolvedValue([row]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const service = new SystemService({ insert } as never);

    const result = await service.setConfig('weights', { output: 1 }, 'user-1');

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ configKey: 'weights', updatedBy: 'user-1' }),
    );
    const conflict = onConflictDoUpdate.mock.calls[0][0] as {
      target: unknown[];
      set: Record<string, unknown>;
    };
    expect(conflict.target).toEqual([
      ewohSchedulerConfig.orgId,
      ewohSchedulerConfig.configKey,
    ]);
    expect(conflict.set).toEqual(
      expect.objectContaining({ configValue: { output: 1 }, updatedBy: 'user-1' }),
    );
    expect(result.updatedBy).toBe('user-1');
  });

  it('rejects config writes without an authenticated user context', async () => {
    const service = new SystemService({ insert: jest.fn() } as never);

    await expect(service.setConfig('weights', {}, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
