import {
  nextTemplateStatus,
  ScaleService,
} from '../../../server/modules/scale/scale.service';
import {
  ewohAssetPackage,
  ewohFactoryProfile,
  ewohFactoryTemplate,
  ewohSchedulerConfig,
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

  it('previews template config inheritance and diff', async () => {
    const template = {
      templateId: 'TPL-1',
      configJson: { shift: { count: 1 }, safety: { enabled: true } },
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([template]),
        })),
      })),
    };
    const service = new ScaleService(
      db as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const result = await service.diffPreview('TPL-1', {
      config: { shift: { count: 3 }, newFlag: true },
    });

    expect(result.mergedConfig).toEqual({
      shift: { count: 3 },
      safety: { enabled: true },
      newFlag: true,
    });
    expect(result.diff.changed).toContain('shift');
    expect(result.diff.added).toContain('newFlag');
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

  it('registers a mapping asset package', async () => {
    const row = { packageId: 'PKG-MAP', packageType: 'mapping' };
    const { insert, entries } = createInsertMock([row]);
    const service = new ScaleService(
      { insert } as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.registerMapping({
      mappingId: 'PKG-MAP',
      name: 'exoskeleton-telemetry-v1',
      version: '1.0.0',
      source: { system: 'exo-jsonl', schemaRef: 'ewoh:///schemas/exo-frame/v1' },
      target: { system: 'ewoh', schemaRef: 'ewoh:///schemas/telemetry/v1' },
      rules: [
        { from: 'entity_id', to: 'entityId', required: true },
        { from: 'load.total_kg', to: 'payload.load.totalKg' },
      ],
    });

    expect(result.packageType).toBe('mapping');
    expect(entries[0].table).toBe(ewohAssetPackage);
    expect(
      (
        entries[0].rows as {
          manifestJson: Record<string, unknown>;
        }
      ).manifestJson.mappingSchemaVersion,
    ).toBe('v1');
  });

  it('dry-runs mapping rules against a sample payload', async () => {
    const mappingRow = {
      packageId: 'PKG-MAP',
      packageType: 'mapping',
      name: 'erp-order-to-ewoh',
      manifestJson: {
        mappingSchemaVersion: 'v1',
        source: { system: 'erp', schemaRef: 'ewoh:///schemas/erp-order/v1' },
        target: { system: 'ewoh', schemaRef: 'ewoh:///schemas/order/v1' },
        rules: [
          { from: 'order.id', to: 'orderId', required: true },
          { from: 'note', to: 'note', transform: 'trim' },
          { from: 'qty', to: 'quantity', transform: 'number' },
        ],
      },
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([mappingRow]),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.dryRunMapping(
      'PKG-MAP',
      { order: { id: 'O-1' }, note: '  ready  ', qty: '3' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.passed).toBe(true);
    expect(result.mapped).toEqual({
      orderId: 'O-1',
      note: 'ready',
      quantity: 3,
    });
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.mapping.dry_run' }),
    );
  });

  it('localizes required and transform errors to source/target fields', async () => {
    const mappingRow = {
      packageId: 'PKG-MAP-BAD',
      packageType: 'mapping',
      name: 'bad-mapping',
      manifestJson: {
        mappingSchemaVersion: 'v1',
        source: { system: 'erp', schemaRef: 'ewoh:///schemas/erp-order/v1' },
        target: { system: 'ewoh', schemaRef: 'ewoh:///schemas/order/v1' },
        rules: [
          { from: 'order.id', to: 'orderId', required: true },
          { from: 'qty', to: 'quantity', transform: 'number' },
        ],
      },
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([mappingRow]),
        })),
      })),
    };
    const service = new ScaleService(
      db as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.dryRunMapping(
      'PKG-MAP-BAD',
      { qty: 'not-a-number' },
    );

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REQUIRED_FIELD_MISSING',
          sourceField: 'order.id',
          targetField: 'orderId',
        }),
        expect.objectContaining({
          code: 'TRANSFORM_ERROR',
          sourceField: 'qty',
          targetField: 'quantity',
        }),
      ]),
    );
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

  it('runs mapping conformance checks', async () => {
    const asset = {
      packageId: 'PKG-MAP',
      packageType: 'mapping',
      version: '1.0.0',
      manifestJson: {
        mappingSchemaVersion: 'v1',
        source: { system: 'exo-jsonl', schemaRef: 'ewoh:///schemas/exo-frame/v1' },
        target: { system: 'ewoh', schemaRef: 'ewoh:///schemas/telemetry/v1' },
        rules: [
          { from: 'entity_id', to: 'entityId' },
          { from: 'load.total_kg', to: 'payload.load.totalKg' },
        ],
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

    const result = await service.runConformance('PKG-MAP');

    expect(result.passed).toBe(true);
    expect(
      result.checks.some((check) => check.check === 'mappingSchemaVersion'),
    ).toBe(true);
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

  it('is idempotent when a scenario pack is already installed', async () => {
    const asset = {
      packageId: 'PKG-SCEN',
      packageType: 'scenario',
      status: 'installed',
    };
    const selectWhere = jest.fn().mockResolvedValue([asset]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(),
    };
    const audit = { appendAuditLog: jest.fn() };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.installScenarioPack('PKG-SCEN');

    expect(result.status).toBe('installed');
    expect(db.update).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
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

  it('uninstalls a scenario pack with audit', async () => {
    const asset = {
      packageId: 'PKG-SCEN',
      packageType: 'scenario',
      status: 'installed',
    };
    const selectWhere = jest.fn().mockResolvedValue([asset]);
    const updateReturning = jest.fn().mockResolvedValue([
      { ...asset, status: 'uninstalled' },
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

    const result = await service.uninstallScenarioPack('PKG-SCEN');

    expect(result.status).toBe('uninstalled');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.scenario.uninstall' }),
    );
  });

  it('is idempotent when a scenario pack is already uninstalled', async () => {
    const asset = {
      packageId: 'PKG-SCEN',
      packageType: 'scenario',
      status: 'uninstalled',
    };
    const selectWhere = jest.fn().mockResolvedValue([asset]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(),
    };
    const audit = { appendAuditLog: jest.fn() };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.uninstallScenarioPack('PKG-SCEN');

    expect(result.status).toBe('uninstalled');
    expect(db.update).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
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

  it('upgrades only profiles in the requested ring', async () => {
    const profiles = [
      {
        profileId: 'PRF-1',
        status: 'installed',
        configJson: { upgradeRing: 'pilot' },
      },
      {
        profileId: 'PRF-2',
        status: 'installed',
        configJson: { upgradeRing: 'shadow' },
      },
    ];
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
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn().mockResolvedValue(profiles),
        where: jest.fn().mockResolvedValue([asset]),
      })),
    }));
    const updateWhere = jest.fn().mockResolvedValue([]);
    const db = {
      select,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.fleetUpgrade('PKG-CONN', undefined, 'shadow');

    expect(result.targetRing).toBe('shadow');
    expect(result.updatedProfiles).toBe(1);
    expect(result.skippedProfiles).toBe(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scale.fleet.upgrade',
        after: expect.objectContaining({
          targetRing: 'shadow',
          updatedProfiles: 1,
          skippedProfiles: 1,
        }),
      }),
    );
  });

  it('skips profiles that are already upgraded', async () => {
    const profiles = [
      { profileId: 'PRF-1', status: 'upgraded' },
      { profileId: 'PRF-2', status: 'installed' },
    ];
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
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn().mockResolvedValue(profiles),
        where: jest.fn().mockResolvedValue([asset]),
      })),
    }));
    const updateWhere = jest.fn().mockResolvedValue([]);
    const db = {
      select,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.fleetUpgrade('PKG-CONN');

    expect(result.updatedProfiles).toBe(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('rolls back only profiles in the requested ring', async () => {
    const profiles = [
      {
        profileId: 'PRF-1',
        status: 'upgraded',
        configJson: { upgradeRing: 'pilot' },
      },
      {
        profileId: 'PRF-2',
        status: 'upgraded',
        configJson: { upgradeRing: 'small' },
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn().mockResolvedValue(profiles),
      })),
    }));
    const updateWhere = jest.fn().mockResolvedValue([]);
    const db = {
      select,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.fleetRollback(undefined, 'small');

    expect(result.targetRing).toBe('small');
    expect(result.rolledBackProfiles).toBe(1);
    expect(result.skippedProfiles).toBe(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('reports fleet status and generates a redacted support bundle', async () => {
    const profiles = [
      {
        profileId: 'PRF-1',
        factoryName: 'Factory A',
        templateId: 'TPL-1',
        status: 'upgraded',
        configJson: { upgradeRing: 'shadow' },
        installedAt: null,
        createdAt: new Date(),
      },
    ];
    const templates = [
      {
        templateId: 'TPL-1',
        name: 'golden',
        version: '1.0.0',
        lifecycleStatus: 'published',
        compatibleCore: '>=0.6.0-rc2',
        publishedAt: null,
      },
    ];
    const assets = [
      {
        packageId: 'PKG-1',
        packageType: 'mapping',
        name: 'mapping-a',
        version: '1.0.0',
        status: 'published',
        publishedAt: null,
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        orderBy: jest.fn().mockResolvedValue(
          table === ewohFactoryProfile
            ? profiles
            : table === ewohFactoryTemplate
              ? templates
              : assets,
        ),
      })),
    }));
    const db = { select };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService(db as never, audit as never);

    const status = await service.fleetStatus();
    expect(status.factoryCount).toBe(1);
    expect(status.templateCount).toBe(1);
    expect(status.assetPackageCount).toBe(1);
    expect(status.ringCounts.shadow).toBe(1);
    expect(status.profiles[0].upgradeRing).toBe('shadow');

    const bundle = await service.generateSupportBundle({
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });
    expect(bundle.bundleId).toMatch(/^SB-/);
    expect(bundle.includesSecrets).toBe(false);
    expect(bundle.orgId).toBe('org-1');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.support_bundle.generate' }),
    );
  });

  it('returns a compatibility catalog for asset packages', async () => {
    const assets = [
      {
        packageId: 'PKG-CONN',
        packageType: 'connector',
        name: 'opcua',
        version: '1.2.0',
        status: 'published',
        manifestJson: {
          compatibility: { core: '>=0.6.0-rc2 <1.0.0' },
        },
      },
      {
        packageId: 'PKG-OLD',
        packageType: 'connector',
        name: 'legacy',
        version: '0.5.0',
        status: 'published',
        manifestJson: {
          compatibility: { core: '>0.6.0' },
        },
      },
      {
        packageId: 'PKG-MAP',
        packageType: 'mapping',
        name: 'mapping-a',
        version: '1.0.0',
        status: 'published',
        manifestJson: {},
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn().mockResolvedValue(assets),
      })),
    }));
    const service = new ScaleService(
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const result = await service.compatibilityCatalog();

    expect(result.coreVersion).toBe('0.6.0-rc4');
    expect(result.compatibleCount).toBe(2);
    expect(result.incompatibleCount).toBe(1);
    expect(
      result.assets.find((row) => row.packageId === 'PKG-CONN')?.compatible,
    ).toBe(true);
    expect(
      result.assets.find((row) => row.packageId === 'PKG-OLD')?.compatible,
    ).toBe(false);
    expect(
      result.assets.find((row) => row.packageId === 'PKG-MAP')?.reason,
    ).toBe('unconstrained');
  });

  it('returns scale productization metrics', async () => {
    const assets = [
      {
        packageId: 'PKG-SCEN',
        packageType: 'scenario',
        name: 'mes',
        version: '1.0.0',
        status: 'installed',
        manifestJson: {},
      },
      {
        packageId: 'PKG-CONN',
        packageType: 'connector',
        name: 'opcua',
        version: '1.0.0',
        status: 'published',
        manifestJson: {},
      },
      {
        packageId: 'PKG-MAP',
        packageType: 'mapping',
        name: 'mapping',
        version: '1.0.0',
        status: 'draft',
        manifestJson: {},
      },
    ];
    const profiles = [
      {
        profileId: 'PRF-1',
        factoryName: 'A',
        templateId: 'TPL-1',
        status: 'installed',
        configJson: { upgradeRing: 'pilot' },
        installedAt: null,
        createdAt: new Date(),
      },
      {
        profileId: 'PRF-2',
        factoryName: 'B',
        templateId: 'TPL-1',
        status: 'installed',
        configJson: { upgradeRing: 'shadow' },
        installedAt: null,
        createdAt: new Date(),
      },
    ];
    const templates = [
      {
        templateId: 'TPL-1',
        name: 'golden',
        version: '1.0.0',
        lifecycleStatus: 'published',
        compatibleCore: null,
        publishedAt: null,
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        orderBy: jest.fn().mockResolvedValue(
          table === ewohAssetPackage
            ? assets
            : table === ewohFactoryProfile
              ? profiles
              : templates,
        ),
      })),
    }));
    const service = new ScaleService(
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const result = await service.scaleMetrics();

    expect(result.templateCount).toBe(1);
    expect(result.profileCount).toBe(2);
    expect(result.assetPackageCount).toBe(3);
    expect(result.scenarioCount).toBe(1);
    expect(result.connectorCount).toBe(1);
    expect(result.mappingCount).toBe(1);
    expect(result.publishedRate).toBeCloseTo(0.667, 3);
    expect(result.ringCounts).toEqual({ pilot: 1, shadow: 1 });
    expect(result.compatibility.compatibleCount).toBe(3);
  });

  it('registers a factory difference with audit', async () => {
    const row = {
      configKey: 'diff.FactoryA.weighing',
      configValue: {
        factoryName: 'FactoryA',
        key: 'weighing',
        category: 'process',
        value: true,
        status: 'open',
      },
      updatedBy: 'user-1',
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const returning = jest.fn().mockResolvedValue([row]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ScaleService({ insert } as never, audit as never);

    const result = await service.registerFactoryDifference(
      {
        factoryName: 'FactoryA',
        key: 'weighing',
        category: 'process',
        value: true,
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.factoryName).toBe('FactoryA');
    expect(result.status).toBe('open');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ configKey: 'diff.FactoryA.weighing' }),
    );
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.difference.register' }),
    );
  });

  it('lists factory differences from the config store', async () => {
    const rows = [
      {
        configKey: 'diff.FactoryA.weighing',
        configValue: {
          factoryName: 'FactoryA',
          key: 'weighing',
          category: 'process',
          value: true,
          status: 'open',
        },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => ({
          orderBy: jest.fn().mockResolvedValue(
            table === ewohSchedulerConfig ? rows : [],
          ),
        })),
      })),
    }));
    const service = new ScaleService(
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const result = await service.listFactoryDifferences();

    expect(result).toHaveLength(1);
    expect(result[0].factoryName).toBe('FactoryA');
  });

  it('resolves a factory difference with audit', async () => {
    const row = {
      configKey: 'diff.FactoryA.weighing',
      configValue: {
        factoryName: 'FactoryA',
        key: 'weighing',
        category: 'process',
        value: true,
        status: 'open',
      },
      updatedBy: 'user-1',
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const selectWhere = jest.fn().mockResolvedValue([row]);
    const updateReturning = jest.fn().mockResolvedValue([
      {
        ...row,
        configValue: { ...row.configValue, status: 'resolved' },
      },
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

    const result = await service.resolveFactoryDifference(
      'diff.FactoryA.weighing',
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('resolved');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.difference.resolve' }),
    );
  });

  it('is idempotent when a factory difference is already resolved', async () => {
    const row = {
      configKey: 'diff.FactoryA.weighing',
      configValue: {
        factoryName: 'FactoryA',
        key: 'weighing',
        category: 'process',
        value: true,
        status: 'resolved',
      },
      updatedBy: 'user-1',
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const selectWhere = jest.fn().mockResolvedValue([row]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(),
    };
    const audit = { appendAuditLog: jest.fn() };
    const service = new ScaleService(db as never, audit as never);

    const result = await service.resolveFactoryDifference(
      'diff.FactoryA.weighing',
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('resolved');
    expect(db.update).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });
});
