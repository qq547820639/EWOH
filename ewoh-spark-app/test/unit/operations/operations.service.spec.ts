import {
  defaultWorkCenterFlags,
  nextAssetStatus,
  nextMaintenanceTaskStatus,
  nextToolStatus,
  OperationsService,
  WORK_CENTER_FLAG_KEYS,
} from '../../../server/modules/operations/operations.service';
import { ewohSchedulerConfig } from '@server/database/schema';

describe('operations state machines', () => {
  it('walks maintenance asset lifecycle', () => {
    expect(nextAssetStatus('active', 'flag_maintenance')).toBe(
      'maintenance_required',
    );
    expect(nextAssetStatus('maintenance_required', 'activate')).toBe('active');
    expect(nextAssetStatus('active', 'decommission')).toBe('decommissioned');
    expect(nextAssetStatus('decommissioned', 'activate')).toBe('active');
    expect(nextAssetStatus('decommissioned', 'flag_maintenance')).toBeNull();
  });

  it('walks maintenance task lifecycle', () => {
    expect(nextMaintenanceTaskStatus('planned', 'start')).toBe('in_progress');
    expect(nextMaintenanceTaskStatus('in_progress', 'complete')).toBe(
      'completed',
    );
    expect(nextMaintenanceTaskStatus('planned', 'cancel')).toBe('cancelled');
    expect(nextMaintenanceTaskStatus('completed', 'start')).toBeNull();
  });

  it('walks tool lifecycle', () => {
    expect(nextToolStatus('calibration_due', 'calibrate')).toBe('active');
    expect(nextToolStatus('active', 'retire')).toBe('retired');
    expect(nextToolStatus('retired', 'calibrate')).toBeNull();
  });

  it('defaults every work center flag to false', () => {
    const flags = defaultWorkCenterFlags();
    expect(WORK_CENTER_FLAG_KEYS).toHaveLength(8);
    for (const key of WORK_CENTER_FLAG_KEYS) {
      expect(flags[key]).toBe(false);
    }
  });
});

interface ConfigRow {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

function extractConditionValue(condition: unknown): string | null {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)
    ?.queryChunks;
  if (!Array.isArray(chunks)) {
    return null;
  }
  let value: string | null = null;
  for (const chunk of chunks) {
    if (chunk !== null && typeof chunk === 'object') {
      const candidate = (chunk as Record<string, unknown>).value;
      if (Array.isArray(candidate)) {
        continue;
      }
      if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
        value = String(candidate);
      }
      continue;
    }
    if (
      chunk !== null &&
      (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean')
    ) {
      value = String(chunk);
    }
  }
    return value;
}

function createDb(initial: ConfigRow[] = []) {
  const rows: ConfigRow[] = [...initial];
  let rowSequence = 0;
  const insertEntries: Array<{ table: unknown; values: unknown }> = [];

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
            updatedAt: new Date(Date.now() + rowSequence++),
          };
          const existing = rows.findIndex(
            (candidate) => candidate.configKey === row.configKey,
          );
          if (existing >= 0) {
            rows[existing] = row;
          } else {
            rows.push(row);
          }
          insertEntries.push({ table, values });
          return [row];
        }),
      })),
    })),
  }));

  return {
    db: { select, insert } as never,
    rows,
    insertEntries,
  };
}

function createActor() {
  return { userId: 'user-1', primaryOrgId: 'org-1' };
}

describe('OperationsService', () => {
  it('registers a maintenance asset and writes audit', async () => {
    const { db, rows, insertEntries } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OperationsService(db, audit as never);

    const result = await service.registerAsset(
      {
        name: 'CNC-01 主轴',
        category: 'device',
        intervalDays: 30,
        location: 'A1',
      },
      createActor(),
    );

    expect(result.status).toBe('active');
    expect(result.nextDueAt).toBeTruthy();
    expect(rows[0].configKey).toMatch(/^eam\.asset\./);
    expect(insertEntries[0].table).toBe(ewohSchedulerConfig);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operations.asset.register' }),
    );
  });

  it('rejects invalid asset category and interval', async () => {
    const { db } = createDb();
    const service = new OperationsService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.registerAsset({ name: 'bad', category: 'robot' }),
    ).rejects.toThrow('unsupported asset category');
    await expect(
      service.registerAsset({ name: 'bad', category: 'device', intervalDays: 0 }),
    ).rejects.toThrow('intervalDays must be positive');
  });

  it('flags an asset for maintenance', async () => {
    const initial = createDb();
    const service = new OperationsService(
      initial.db,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const asset = await service.registerAsset(
      { name: 'Pump-01', category: 'utility' },
      createActor(),
    );

    const updated = await service.transitionAsset(
      asset.assetId,
      'flag_maintenance',
      createActor(),
    );
    expect(updated.status).toBe('maintenance_required');
    expect(updated.history.at(-1)?.note).toBe('flag_maintenance');
  });

  it('completing a maintenance task refreshes the linked asset due date', async () => {
    const { db, rows } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OperationsService(db, audit as never);
    const asset = await service.registerAsset(
      { name: 'Robot-01', category: 'device', intervalDays: 90 },
      createActor(),
    );
    const task = await service.registerMaintenanceTask(
      { assetId: asset.assetId, title: '年度保养', taskType: 'preventive' },
      createActor(),
    );
    await service.transitionMaintenanceTask(
      task.taskId,
      'start',
      {},
      createActor(),
    );
    const completed = await service.transitionMaintenanceTask(
      task.taskId,
      'complete',
      { result: 'OK', note: '全部通过' },
      createActor(),
    );

    expect(completed.status).toBe('completed');
    expect(completed.result).toBe('OK');
    const assetRow = rows.find(
      (row) => row.configKey === `eam.asset.${asset.assetId}`,
    );
    const assetValue = assetRow?.configValue as {
      status: string;
      lastCompletedAt: string;
      nextDueAt: string;
    };
    expect(assetValue.status).toBe('active');
    expect(assetValue.lastCompletedAt).toBeTruthy();
    expect(assetValue.nextDueAt > assetValue.lastCompletedAt).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operations.task.complete' }),
    );
  });

  it('registers and calibrates a tool', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OperationsService(db, audit as never);
    const tool = await service.registerTool(
      {
        name: '扭力扳手-01',
        category: 'tooling',
        calibrationIntervalDays: 180,
      },
      createActor(),
    );
    const calibrated = await service.transitionTool(
      tool.toolId,
      'calibrate',
      createActor(),
    );
    expect(calibrated.status).toBe('active');
    expect(calibrated.lastCalibratedAt).toBeTruthy();
    expect(calibrated.calibrationHistory).toHaveLength(1);
  });

  it('upserts work center flags and rejects non-boolean values', async () => {
    const { db } = createDb();
    const service = new OperationsService(
      db,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const result = await service.upsertWorkCenter(
      {
        name: '加工中心 A1',
        capabilities: ['mes-p0', 'oee'],
        flags: {
          firstInspectionRequired: true,
          scanRequired: true,
          exoskeletonRequired: true,
          riskConfirmationRequired: true,
        },
      },
      createActor(),
    );
    expect(result.flags.firstInspectionRequired).toBe(true);
    expect(result.flags.handoverRequired).toBe(false);
    await expect(
      service.upsertWorkCenter({
        name: 'bad',
        flags: { scanRequired: 'yes' as never },
      }),
    ).rejects.toThrow('must be boolean');
  });

  it('records efficiency with an existing standard hour', async () => {
    const { db } = createDb();
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OperationsService(db, audit as never);
    await service.registerStandardHour(
      {
        workCenterId: 'WC-A1',
        operationCode: 'OP-100',
        operationName: '精加工',
        standardMinutes: 10,
      },
      createActor(),
    );
    const entry = await service.registerEfficiencyEntry(
      {
        workerId: 'P-1',
        workCenterId: 'WC-A1',
        operationCode: 'OP-100',
        actualMinutes: 8,
      },
      createActor(),
    );
    expect(entry.efficiencyPercent).toBe(125);
    expect(entry.deviationMinutes).toBe(-2);
  });

  it('rejects efficiency without a matching standard hour', async () => {
    const { db } = createDb();
    const service = new OperationsService(
      db,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.registerEfficiencyEntry({
        workerId: 'P-1',
        workCenterId: 'WC-A1',
        operationCode: 'OP-999',
        actualMinutes: 10,
      }),
    ).rejects.toThrow('no standard hour');
  });

  it('summarizes worker efficiency fairness', async () => {
    const { db } = createDb();
    const service = new OperationsService(
      db,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );
    await service.registerStandardHour(
      {
        workCenterId: 'WC-A1',
        operationCode: 'OP-1',
        operationName: 'OP-1',
        standardMinutes: 10,
      },
      createActor(),
    );
    await service.registerEfficiencyEntry(
      {
        workerId: 'P-1',
        workCenterId: 'WC-A1',
        operationCode: 'OP-1',
        actualMinutes: 10,
      },
      createActor(),
    );
    await service.registerEfficiencyEntry(
      {
        workerId: 'P-2',
        workCenterId: 'WC-A1',
        operationCode: 'OP-1',
        actualMinutes: 20,
      },
      createActor(),
    );
    const summary = await service.efficiencySummary();
    expect(summary.entryCount).toBe(2);
    expect(summary.workerCount).toBe(2);
    expect(summary.averageEfficiencyPercent).toBe(75);
    expect(summary.fairnessStdDev).toBe(25);
  });
});
