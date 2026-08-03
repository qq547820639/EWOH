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
});
