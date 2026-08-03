import { ParametersService } from '../../../server/modules/parameters/parameters.service';
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

describe('ParametersService', () => {
  it('registers an approved number parameter with validation', async () => {
    const { db, rows, insertEntries } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ParametersService(db, audit as never);

    const result = await service.register(
      {
        key: 'oee.availability.target',
        name: 'OEE 可用率目标',
        dataType: 'number',
        current: 0.85,
        unit: '%',
        validation: { min: 0, max: 1 },
        scope: { factoryId: 'factory-a' },
      },
      actor,
    );

    expect(result.status).toBe('active');
    expect(result.key).toBe('oee.availability.target');
    expect(rows[0].configKey).toBe('param.oee.availability.target');
    expect(insertEntries[0].table).toBe(ewohSchedulerConfig);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'parameters.register' }),
    );
  });

  it('rejects values outside validation range', async () => {
    const { db } = createDb();
    const service = new ParametersService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.register(
        {
          key: 'bad',
          name: 'bad',
          dataType: 'number',
          current: 2,
          validation: { max: 1 },
        },
        actor,
      ),
    ).rejects.toThrow('above validation max');
  });

  it('keeps approval-required parameters pending until approved', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ParametersService(db, audit as never);
    const created = await service.register(
      {
        key: 'control.torque.limit',
        name: '扭矩上限',
        dataType: 'integer',
        current: 40,
        approvalRequired: true,
      },
      actor,
    );
    expect(created.status).toBe('pending');

    const approved = await service.approve(created.key, actor);
    expect(approved.status).toBe('active');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'parameters.approve' }),
    );
  });

  it('updates and rolls back to the previous value', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ParametersService(db, audit as never);
    const created = await service.register(
      {
        key: 'sampling.rate',
        name: '采样率',
        dataType: 'integer',
        current: 10,
        unit: 'Hz',
      },
      actor,
    );
    const updated = await service.update(
      created.key,
      { current: 20, note: 'tune' },
      actor,
    );
    expect(updated.version).toBe(2);
    expect(updated.current).toBe(20);
    expect(updated.history).toHaveLength(1);

    const rolledBack = await service.rollback(created.key, actor);
    expect(rolledBack.current).toBe(10);
    expect(rolledBack.version).toBe(3);
    expect(rolledBack.history.at(-1)?.value).toBe(20);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'parameters.rollback' }),
    );
  });

  it('retires a parameter and summarizes status counts', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ParametersService(db, audit as never);
    const created = await service.register(
      { key: 'legacy.flag', name: 'legacy', dataType: 'boolean', current: true },
      actor,
    );
    await service.retire(created.key, actor);
    const summary = await service.summary();
    expect(summary.totalCount).toBe(1);
    expect(summary.statusCounts.retired).toBe(1);
    expect(summary.dataTypeCounts.boolean).toBe(1);
  });

  it('throws not found for missing parameter', async () => {
    const { db } = createDb();
    const service = new ParametersService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(service.get('missing')).rejects.toThrow('not found');
  });
});
