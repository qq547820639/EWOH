import {
  nextTemplateStatus,
  ScaleService,
} from '../../../server/modules/scale/scale.service';
import {
  ewohAssetPackage,
  ewohFactoryProfile,
  ewohFactoryTemplate,
} from '@server/database/schema';

describe('template lifecycle', () => {
  it('walks draft -> reviewed -> certified -> published -> deprecated -> retired', () => {
    let status = 'draft';
    for (const action of ['review', 'certify', 'publish', 'deprecate', 'retire']) {
      status = nextTemplateStatus(status, action)!;
      expect(status).not.toBeNull();
    }
    expect(status).toBe('retired');
  });

  it('rejects illegal transitions', () => {
    expect(nextTemplateStatus('draft', 'publish')).toBeNull();
    expect(nextTemplateStatus('certified', 'retire')).toBeNull();
  });
});

function createInsertMock(returnRows: unknown[]) {
  const entries: Array<{ table: unknown; rows: unknown }> = [];
  const insert = jest.fn((table: unknown) => ({
    values: jest.fn((rows: unknown) => {
      entries.push({ table, rows });
      return { returning: jest.fn().mockResolvedValue(returnRows) };
    }),
  }));
  return { insert, entries };
}

describe('ScaleService templates and assets', () => {
  it('registers a factory template with audit', async () => {
    const row = { templateId: 'TPL-1', lifecycleStatus: 'draft' };
    const { insert, entries } = createInsertMock([row]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService({ insert } as never, audit as never);

    const result = await service.registerTemplate(
      { name: '离散机加工', version: '1.0.0' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.templateId).toBe('TPL-1');
    expect(entries[0].table).toBe(ewohFactoryTemplate);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.template.register' }),
    );
  });

  it('publishes a template and installs a factory profile', async () => {
    const template = {
      templateId: 'TPL-1',
      lifecycleStatus: 'certified',
      publishedAt: null,
    };
    const selectWhere = jest.fn().mockResolvedValue([template]);
    const updateReturning = jest.fn().mockResolvedValue([
      { ...template, lifecycleStatus: 'published' },
    ]);
    const profileRows = [{ profileId: 'PRF-1', status: 'installed' }];
    const { insert, entries } = createInsertMock(profileRows);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
      insert,
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const published = await service.transitionTemplate('TPL-1', 'publish');
    expect(published.lifecycleStatus).toBe('published');
    selectWhere.mockResolvedValue([
      { ...template, lifecycleStatus: 'published' },
    ]);

    const profile = await service.installTemplate(
      'TPL-1',
      { factoryName: '工厂B' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(profile.profileId).toBe('PRF-1');
    expect(entries.some((entry) => entry.table === ewohFactoryProfile)).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.template.install' }),
    );
  });

  it('rejects install until template is published', async () => {
    const template = { templateId: 'TPL-1', lifecycleStatus: 'draft' };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([template]) })),
      })),
      insert: jest.fn(),
    };
    const service = new ScaleService(
      db as never,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.installTemplate('TPL-1', { factoryName: '工厂B' }),
    ).rejects.toThrow('must be published');
  });

  it('registers an asset package', async () => {
    const row = { packageId: 'PKG-1', packageType: 'scenario' };
    const { insert, entries } = createInsertMock([row]);
    const service = new ScaleService(
      { insert } as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.registerAssetPackage({
      packageType: 'scenario',
      name: 'heavy-lifting-safety',
      version: '1.0.0',
      manifest: { requires: [] },
    });

    expect(result.packageId).toBe('PKG-1');
    expect(entries[0].table).toBe(ewohAssetPackage);
  });

  it('registers a connector package', async () => {
    const row = { packageId: 'PKG-CONN', packageType: 'connector' };
    const { insert, entries } = createInsertMock([row]);
    const service = new ScaleService(
      { insert } as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.registerConnector({
      name: 'opcua-generic-machinery',
      version: '1.2.0',
      runtime: 'edge-python',
      protocol: 'opcua',
      outputEvents: ['DeviceStateChanged'],
    });

    expect(result.packageType).toBe('connector');
    expect(entries[0].table).toBe(ewohAssetPackage);
    expect(
      (entries[0].rows as { manifestJson: Record<string, unknown> }).manifestJson
        .protocol,
    ).toBe('opcua');
  });

  it('registers a scenario pack', async () => {
    const row = { packageId: 'PKG-SCEN', packageType: 'scenario' };
    const { insert } = createInsertMock([row]);
    const service = new ScaleService(
      { insert } as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.registerScenarioPack({
      name: 'heavy-lifting-safety',
      version: '1.0.0',
      requires: { connectors: ['exoskeleton-frame@1.x'] },
    });

    expect(result.packageType).toBe('scenario');
  });

  it('replays a factory profile by merging template config with profile overrides', async () => {
    const profile = {
      profileId: 'PRF-1',
      templateId: 'TPL-1',
      status: 'installed',
      configJson: { shift: { count: 3 } },
      installedAt: null,
    };
    const template = {
      templateId: 'TPL-1',
      lifecycleStatus: 'published',
      configJson: { shift: { count: 1 }, safety: { enabled: true } },
      publishedAt: null,
    };
    const select = jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohFactoryProfile) {
            return Promise.resolve([profile]);
          }
          return Promise.resolve([template]);
        }),
      })),
    }));
    const updateReturning = jest.fn().mockResolvedValue([
      {
        ...profile,
        status: 'replayed',
        configJson: {
          shift: { count: 3 },
          safety: { enabled: true },
        },
      },
    ]);
    const db = {
      select,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.replayProfile('PRF-1', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });

    expect(result.status).toBe('replayed');
    expect(result.configJson).toEqual({
      shift: { count: 3 },
      safety: { enabled: true },
    });
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.profile.replay' }),
    );
  });

  it('runs connector conformance checks', async () => {
    const asset = {
      packageId: 'PKG-CONN',
      packageType: 'connector',
      version: '1.2.0',
      manifestJson: {
        runtime: 'edge-python',
        protocol: 'opcua',
        configSchema: {},
        compatibility: {},
        outputEvents: ['DeviceStateChanged'],
      },
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([asset]),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.runConformance('PKG-CONN');

    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('installs a scenario pack', async () => {
    const asset = {
      packageId: 'PKG-SCEN',
      packageType: 'scenario',
      version: '1.0.0',
      status: 'draft',
      manifestJson: {
        requires: {},
        workflows: ['mes-execution'],
        policies: ['operator-safety'],
        acceptance: 'smoke',
      },
    };
    const selectWhere = jest.fn().mockResolvedValue([asset]);
    const updateReturning = jest.fn().mockResolvedValue([
      { ...asset, status: 'installed' },
    ]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.installScenarioPack('PKG-SCEN');

    expect(result.status).toBe('installed');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.scenario.install' }),
    );
  });

  it('rejects installing a scenario pack that fails conformance', async () => {
    const asset = {
      packageId: 'PKG-SCEN-BAD',
      packageType: 'scenario',
      version: '1.0.0',
      status: 'draft',
      manifestJson: {},
    };
    const selectWhere = jest.fn().mockResolvedValue([asset]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    await expect(service.installScenarioPack('PKG-SCEN-BAD')).rejects.toThrow(
      'does not pass conformance',
    );
    expect(audit.appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it('rolls back all factory profiles', async () => {
    const profiles = [{ profileId: 'PRF-1' }, { profileId: 'PRF-2' }];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          orderBy: jest.fn().mockResolvedValue(profiles),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.fleetRollback();

    expect(result.rolledBackProfiles).toBe(2);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.fleet.rollback' }),
    );
  });
});
