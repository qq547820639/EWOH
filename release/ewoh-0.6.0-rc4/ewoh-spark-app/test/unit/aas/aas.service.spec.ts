import { AasService } from '../../../server/modules/aas/aas.service';
import { ewohSchedulerConfig } from '@server/database/schema';

interface ConfigRow {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

function extractConditionValue(condition: unknown): string | null {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return null;
  let value: string | null = null;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      const candidate = (chunk as Record<string, unknown>).value;
      if (Array.isArray(candidate)) continue;
      if (
        typeof candidate === 'string' ||
        typeof candidate === 'number' ||
        typeof candidate === 'boolean'
      ) {
        value = String(candidate);
      }
      continue;
    }
    if (chunk !== null && typeof chunk !== 'object') value = String(chunk);
  }
  return value;
}

function createDb(initial: ConfigRow[] = []) {
  const rows: ConfigRow[] = [...initial];
  const insertEntries: Array<{ table: unknown; values: unknown }> = [];
  let seq = 0;
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn((condition: unknown) => {
        const value = extractConditionValue(condition) ?? '';
        const filtered = value.endsWith('.%')
          ? rows.filter((row) => row.configKey.startsWith(value.slice(0, -1)))
          : rows.filter((row) => row.configKey === value);
        const promise = Promise.resolve(filtered) as Promise<ConfigRow[]> & {
          orderBy?: jest.Mock;
        };
        promise.orderBy = jest.fn(() => Promise.resolve(filtered));
        return promise;
      }),
    })),
  }));
  const insert = jest.fn((table: unknown) => ({
    values: jest.fn((values: unknown) => ({
      onConflictDoUpdate: jest.fn(() => ({
        returning: jest.fn(async () => {
          const value = values as {
            configKey: string;
            configValue: unknown;
            updatedBy: string | null;
          };
          const row: ConfigRow = {
            configKey: value.configKey,
            configValue: value.configValue,
            updatedBy: value.updatedBy,
            updatedAt: new Date(Date.now() + seq++),
          };
          const index = rows.findIndex((candidate) => candidate.configKey === row.configKey);
          if (index >= 0) rows[index] = row;
          else rows.push(row);
          insertEntries.push({ table, values });
          return [row];
        }),
      })),
    })),
  }));
  return { db: { select, insert } as never, rows, insertEntries };
}

const actor = { userId: 'user-1', primaryOrgId: 'org-1' };
const submodels = [
  {
    id: 'urn:submodel:operations',
    idShort: 'operations',
    elements: [
      {
        idShort: 'oeeAvailabilityTarget',
        value: 0.85,
        valueType: 'number',
        unit: '%',
        semanticId: 'ewoh:oee:availability',
      },
    ],
  },
];

describe('AasService', () => {
  it('imports an AAS asset with audit', async () => {
    const { db, rows, insertEntries } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AasService(db, audit as never);

    const result = await service.importAsset(
      {
        assetId: 'urn:ewoh:line:001',
        idShort: '离散机加工线',
        submodels,
      },
      actor,
    );

    expect(result.assetId).toBe('urn:ewoh:line:001');
    expect(result.submodels).toHaveLength(1);
    expect(rows[0].configKey).toBe('aas.urn:ewoh:line:001');
    expect(insertEntries[0].table).toBe(ewohSchedulerConfig);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'aas.asset.import' }),
    );
  });

  it('rejects unsupported value types', async () => {
    const { db } = createDb();
    const service = new AasService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.importAsset(
        {
          assetId: 'urn:bad',
          submodels: [
            {
              id: 'urn:sm',
              elements: [{ idShort: 'p', value: 1, valueType: 'made-up' }],
            },
          ],
        },
        actor,
      ),
    ).rejects.toThrow('unsupported AAS valueType');
  });

  it('lists and gets assets and builds twin semantics', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AasService(db, audit as never);
    const imported = await service.importAsset(
      { assetId: 'urn:line', idShort: 'line', submodels },
      actor,
    );

    const list = await service.listAssets();
    expect(list).toHaveLength(1);
    const fetched = await service.getAsset(imported.assetId);
    expect(fetched.idShort).toBe('line');

    const semantics = await service.getSemantics(imported.assetId);
    expect(semantics.semantics).toEqual(['operations']);
    expect(semantics.submodels[0].properties[0].name).toBe(
      'oeeAvailabilityTarget',
    );
  });

  it('throws not found for missing asset', async () => {
    const { db } = createDb();
    const service = new AasService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(service.getAsset('missing')).rejects.toThrow('not found');
  });
});
