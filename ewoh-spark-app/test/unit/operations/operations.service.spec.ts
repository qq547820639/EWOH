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
    // 方案C：取消=暂缓执行，回到 planned 可重新开工（审计 2026-08-19 变更）。
    expect(nextMaintenanceTaskStatus('planned', 'cancel')).toBe('planned');
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
  // NEST-201：readConfig/listConfigs 条件现含 org 谓词（and(eq(org), eq/like(key))）
  // ——递归遍历 queryChunks/参数对象收集候选值，优先取 configKey 命名空间值
  //（eam./ops.），org 值与 SQL 片段（like/空白/括号）不参与过滤。
  const isConfigKeyLike = (candidate: string) =>
    /^(eam|ops|diff|aas)\./.test(candidate);
  const isSqlNoise = (candidate: string) =>
    /^[\s()]+$/.test(candidate) ||
    /^(like|ilike|and|or|=|%)$/i.test(candidate) ||
    /_id$|_key$|config_key/.test(candidate);
  const values: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (!isSqlNoise(node)) values.push(node);
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.value === 'string' && !isSqlNoise(record.value)) {
      values.push(record.value);
    }
    if (Array.isArray(record.queryChunks)) {
      visit(record.queryChunks);
    }
    for (const child of Object.values(record)) {
      if (child !== null && typeof child === 'object') visit(child);
    }
  };
  visit(condition);
  const keyLike = values.filter(isConfigKeyLike);
  if (keyLike.length > 0) {
    return keyLike[keyLike.length - 1];
  }
  return values.length > 0 ? values[values.length - 1] : null;
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
      service.registerEfficiencyEntry(
        {
          workerId: 'P-1',
          workCenterId: 'WC-A1',
          operationCode: 'OP-999',
          actualMinutes: 10,
        },
        // NEST-201：org 上下文强制。
        createActor(),
      ),
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
    // NEST-201：汇总按 org 作用域（带 actor）。
    const summary = await service.efficiencySummary(createActor());
    expect(summary.entryCount).toBe(2);
    expect(summary.workerCount).toBe(2);
    expect(summary.averageEfficiencyPercent).toBe(75);
    expect(summary.fairnessStdDev).toBe(25);
  });
});
