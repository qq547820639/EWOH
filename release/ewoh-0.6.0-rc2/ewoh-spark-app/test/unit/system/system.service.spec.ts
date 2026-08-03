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

describe('SystemService feature flags', () => {
  it('rejects feature flag keys without the feature. prefix', async () => {
    const service = new SystemService({ insert: jest.fn() } as never);
    await expect(
      service.setFeatureFlag('not-a-flag', true, {}),
    ).rejects.toThrow('must start with feature.');
  });

  it('persists feature flag enabled state and metadata', async () => {
    const row = {
      id: 'flag-1',
      configKey: 'feature.scale.diffPreview',
      configValue: { enabled: true, metadata: { owner: 'scale' } },
      updatedBy: 'user-1',
      createdAt: new Date('2026-08-03T00:00:00Z'),
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const returning = jest.fn().mockResolvedValue([row]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const service = new SystemService({ insert } as never);

    const result = await service.setFeatureFlag(
      'feature.scale.diffPreview',
      true,
      { owner: 'scale' },
      'user-1',
    );

    expect(result.enabled).toBe(true);
    expect(result.metadata).toEqual({ owner: 'scale' });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        configValue: { enabled: true, metadata: { owner: 'scale' } },
      }),
    );
  });

  it('lists and gets feature flags from the org-scoped config store', async () => {
    const rows = [
      {
        configKey: 'feature.scale.diffPreview',
        configValue: { enabled: true, metadata: {} },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };
    const service = new SystemService(db as never);
    const flags = await service.listFeatureFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0].enabled).toBe(true);
  });

  it('throws not found for missing feature flags', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]),
        })),
      })),
    };
    const service = new SystemService(db as never);
    await expect(
      service.getFeatureFlag('feature.missing'),
    ).rejects.toThrow('not found');
  });

  it('evaluates feature flags with OpenFeature-style targeting context', async () => {
    const rows = [
      {
        configKey: 'feature.scale.canary',
        configValue: {
          enabled: true,
          metadata: {
            targeting: {
              rings: ['shadow', 'pilot'],
              roles: ['dispatcher'],
              orgIds: ['org-a'],
              factories: ['factory-a'],
            },
          },
        },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
      {
        configKey: 'feature.scale.safe',
        configValue: { enabled: true, metadata: {} },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
      {
        configKey: 'feature.scale.fallback',
        configValue: {
          enabled: true,
          metadata: {
            targeting: { rings: ['shadow'] },
            fallbackEnabled: true,
          },
        },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };
    const service = new SystemService(db as never);
    const context = {
      orgId: 'org-a',
      factoryId: 'factory-a',
      upgradeRing: 'shadow',
      roles: ['dispatcher'],
    };

    const result = await service.evaluateFeatureFlags(
      ['feature.scale.canary', 'feature.scale.safe', 'feature.missing'],
      context,
    );
    expect(result).toEqual([
      expect.objectContaining({
        key: 'feature.scale.canary',
        enabled: true,
        reason: 'default_on',
        targetingApplied: true,
      }),
      expect.objectContaining({
        key: 'feature.scale.safe',
        enabled: true,
        reason: 'default_on',
        targetingApplied: false,
      }),
      expect.objectContaining({
        key: 'feature.missing',
        enabled: false,
        reason: 'flag_not_found',
        variant: 'off',
      }),
    ]);

    const ringMiss = await service.evaluateFeatureFlags(
      ['feature.scale.canary', 'feature.scale.fallback'],
      { ...context, upgradeRing: 'full' },
    );
    expect(ringMiss[0]).toEqual(
      expect.objectContaining({
        enabled: false,
        reason: 'ring_mismatch',
        variant: 'off',
      }),
    );
    expect(ringMiss[1]).toEqual(
      expect.objectContaining({
        enabled: true,
        reason: 'ring_mismatch',
        variant: 'on',
      }),
    );
  });
});
