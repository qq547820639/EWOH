/* Task 7：Prediction Shadow Learning 持久化（durable observation）。
 *
 * 覆盖（fake drizzle db，jest.fn() 链）：
 *   (a) recordSample 持久化一行完整字段（含 orgId/taskId/correlationId/executionId/版本字段）；
 *   (b) 持久化失败被吞掉（不抛出、不影响内存环形缓冲）；
 *   (c) backfillActual 按 correlation_id 优先更新持久化行（误差/actual_at 正确落库）；
 *   (d) aggregatePersisted 从 fake 行集计算 MAE/RMSE/p50/p95/coverage/fallbackRate/calibration；
 *   (e) pruneObservations 以正确的 created_at 截止调用 delete；
 *   附：listObservations 过滤链；无 db 时 aggregatePersisted 回退内存、prune 返回 0。
 */
/// <reference types="jest" />
import { ShadowEvaluatorService } from '../shadow-evaluator.service';
import type { OrgContext } from '../../../shared/org-context.interceptor';

const orgA: OrgContext = {
  userId: 'uA',
  primaryOrgId: 'orgA',
  role: 'system',
  accessibleOrgIds: ['orgA'],
  isGlobalAdmin: false,
};

const NOW = '2026-08-10T00:00:00.000Z';

/** 等待 fire-and-forget 微任务链完成。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 从 drizzle SQL 对象中收集列名与参数值（按构造器名识别，避免依赖内部 API）。
 *  结构：SQL.queryChunks 含嵌套 SQL/StringChunk/列实例（PgVarchar/PgTimestamp/CustomType…）/Param。 */
function collectSqlTokens(node: unknown): { names: string[]; params: string[] } {
  const names: string[] = [];
  const params: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n !== 'object') return;
    const ctor = (n as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (ctor === 'SQL') {
      (n as { queryChunks: unknown[] }).queryChunks.forEach(walk);
      return;
    }
    if (ctor === 'Name') names.push((n as { value: string }).value);
    if (ctor === 'Param') params.push(String((n as { value: unknown }).value));
    if (ctor === 'Column' || ctor.startsWith('Pg') || ctor === 'CustomType') {
      names.push((n as { name: string }).name);
      return; // 列节点不再下钻（避免 table 回环/内部元数据噪音）。
    }
    if (ctor === 'StringChunk') return;
    if (Array.isArray(n)) {
      (n as unknown[]).forEach(walk);
      return;
    }
    for (const key of Object.keys(n as Record<string, unknown>)) {
      if (key === 'queryChunks') continue;
      walk((n as Record<string, unknown>)[key]);
    }
  };
  walk(node);
  return { names, params };
}

/** 可编程 fake drizzle db：insert/select/update/delete 均为 jest.fn() 链。 */
function makeDb(overrides: {
  selectRows?: Array<Record<string, unknown>>;
  deleteReturning?: Array<Record<string, unknown>>;
} = {}) {
  const captured = {
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    deletedWhere: [] as unknown[],
    selectWhere: [] as unknown[],
  };
  const rows = () => (overrides.selectRows ?? []).map((r) => ({ ...r }));
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        captured.inserted.push({ ...(v as Record<string, unknown>) });
        return Promise.resolve();
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((where: unknown) => {
          captured.selectWhere.push(where);
          return {
            // orderBy 结果可 await（aggregatePersisted 路径）且带 .limit；
            // limit 结果可 await（backfill 路径）且带 .offset（listObservations 路径）。
            orderBy: jest.fn(() =>
              Object.assign(Promise.resolve(rows()), {
                limit: jest.fn(() =>
                  Object.assign(Promise.resolve(rows()), {
                    offset: jest.fn(() => Promise.resolve(rows())),
                  }),
                ),
              }),
            ),
          };
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((set: unknown) => ({
        where: jest.fn((where: unknown) => {
          captured.updated.push({ set: set as Record<string, unknown>, where });
          return Promise.resolve();
        }),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn((where: unknown) => {
        captured.deletedWhere.push(where);
        return {
          returning: jest.fn(() => Promise.resolve(overrides.deleteReturning ?? [])),
        };
      }),
    })),
  };
  return { db, captured };
}

describe('Task 7 ShadowEvaluatorService persistence', () => {
  it('(a) recordSample 持久化一行完整字段（含 orgId/任务/关联/版本字段）', async () => {
    const { db, captured } = makeDb();
    const svc = new ShadowEvaluatorService(db as never);

    svc.recordSample(
      {
        modelVersion: 'model-v2',
        predictionType: 'task_duration',
        inputVersion: 'ws-v1',
        prediction: 30,
        baseline: 40,
        confidence: 0.9,
        createdAt: NOW,
        taskId: 't1',
        entityId: 'task:t1',
        correlationId: 'corr-1',
        executionId: 'exec-1',
        policyVersion: 3,
        snapshotVersion: 'ws-v1',
      },
      orgA,
    );
    await flush();

    expect(captured.inserted).toHaveLength(1);
    const row = captured.inserted[0];
    expect(row.orgId).toBe('orgA');
    expect(row.predictionType).toBe('task_duration');
    expect(row.entityId).toBe('task:t1');
    expect(row.taskId).toBe('t1');
    expect(row.correlationId).toBe('corr-1');
    expect(row.executionId).toBe('exec-1');
    expect(row.prediction).toBe(30);
    expect(row.baseline).toBe(40);
    expect(row.actual).toBeNull();
    expect(row.confidence).toBe(0.9);
    expect(row.modelVersion).toBe('model-v2');
    expect(row.policyVersion).toBe(3);
    expect(row.snapshotVersion).toBe('ws-v1');
    expect(row.createdAt).toBeInstanceOf(Date);

    // 无 ctx（'ALL'）→ org_id 为 null。
    svc.recordSample(
      { modelVersion: 'm1', predictionType: 'travel_time', inputVersion: 'v1', prediction: 5, baseline: 5, confidence: 0.8, createdAt: NOW },
      undefined,
    );
    await flush();
    expect(captured.inserted[1].orgId).toBeNull();
  });

  it('(b) 持久化失败被吞掉：不抛出、不影响内存环形缓冲', async () => {
    const db = {
      insert: jest.fn(() => ({
        values: jest.fn(() => Promise.reject(new Error('db down'))),
      })),
      // maybePrune 会触发 delete；delete 正常返回避免额外噪音。
      delete: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
      })),
    };
    const svc = new ShadowEvaluatorService(db as never);

    expect(() =>
      svc.recordSample(
        { modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 30, baseline: 40, confidence: 0.9, createdAt: NOW, taskId: 't1' },
        orgA,
      ),
    ).not.toThrow();
    await flush();

    // 内存缓冲不受影响。
    expect(svc.listSamples(orgA)).toHaveLength(1);
    expect(svc.listSamples(orgA)[0].prediction).toBe(30);
  });

  it('(c) backfillActual 按 correlation_id 优先更新持久化行（误差/actual_at 正确）', async () => {
    const { db, captured } = makeDb({ selectRows: [{ id: 'row-1', prediction: 30 }] });
    const svc = new ShadowEvaluatorService(db as never);

    svc.backfillActual('task_duration', 20, NOW, orgA, {
      taskId: 't1',
      correlationId: 'corr-1',
    });
    await flush();

    // 匹配用 correlation_id 条件。
    const whereTokens = collectSqlTokens(captured.selectWhere[0]);
    expect(whereTokens.names).toContain('correlation_id');
    expect(whereTokens.params).toContain('corr-1');

    // 更新落库：actual/绝对误差/相对误差/actual_at，按 id 定位。
    expect(captured.updated).toHaveLength(1);
    const patch = captured.updated[0].set;
    expect(patch.actual).toBe(20);
    expect(patch.absoluteError).toBe(10);
    expect(patch.relativeError).toBe(0.5);
    expect(patch.actualAt).toBeInstanceOf(Date);
    const updateTokens = collectSqlTokens(captured.updated[0].where);
    expect(updateTokens.names).toContain('id');
    expect(updateTokens.params).toContain('row-1');
  });

  it('(c2) backfillActual 回退分支：无 correlation_id 时用 (task_id, prediction_type)，再回退 (type, created_at)', async () => {
    const { db, captured } = makeDb({ selectRows: [{ id: 'row-2', prediction: 50 }] });
    const svc = new ShadowEvaluatorService(db as never);

    svc.backfillActual('task_duration', 60, NOW, orgA, { taskId: 't2' });
    await flush();
    const taskTokens = collectSqlTokens(captured.selectWhere[0]);
    expect(taskTokens.names).toContain('task_id');
    expect(taskTokens.names).toContain('prediction_type');
    expect(taskTokens.params).toContain('t2');

    svc.backfillActual('task_duration', 90, NOW, orgA);
    await flush();
    const fuzzyTokens = collectSqlTokens(captured.selectWhere[1]);
    expect(fuzzyTokens.names).toContain('prediction_type');
    expect(fuzzyTokens.names).toContain('created_at');
    expect(fuzzyTokens.params).toContain('task_duration');
  });

  it('(c3) backfillActual 在 DB 无匹配行时静默跳过（不更新、不抛错）', async () => {
    const { db, captured } = makeDb({ selectRows: [] });
    const svc = new ShadowEvaluatorService(db as never);

    expect(() => svc.backfillActual('task_duration', 20, NOW, orgA)).not.toThrow();
    await flush();
    expect(captured.updated).toHaveLength(0);
  });

  it('(d) aggregatePersisted 从 fake 行集计算 MAE/RMSE/p50/p95/coverage/fallbackRate/calibration', async () => {
    const rows = [
      { prediction: 30, actual: 20, absoluteError: 10, relativeError: 0.5, confidence: 0.9, modelVersion: 'ml-v1' },
      { prediction: 50, actual: 60, absoluteError: 10, relativeError: 1 / 6, confidence: 0.9, modelVersion: 'ml-v1' },
      { prediction: 100, actual: 90, absoluteError: 10, relativeError: 1 / 9, confidence: 0.9, modelVersion: 'ml-v1' },
      { prediction: 30, actual: null, absoluteError: null, relativeError: null, confidence: 0.3, modelVersion: 'deterministic-v1' },
    ];
    const { db } = makeDb({ selectRows: rows });
    const svc = new ShadowEvaluatorService(db as never);

    const agg = await svc.aggregatePersisted(orgA);
    expect(agg.mae).toBeCloseTo(10);
    expect(agg.rmse).toBeCloseTo(10);
    expect(agg.p50).toBeCloseTo(10);
    expect(agg.p95).toBeCloseTo(10);
    expect(agg.coverage).toBeCloseTo(0.75);
    expect(agg.fallbackRate).toBeCloseTo(0.25);
    expect(agg.calibration).toBeCloseTo(0);
  });

  it('(e) pruneObservations 以正确的 created_at 截止调用 delete 并返回删除数', async () => {
    const { db, captured } = makeDb({ deleteReturning: [{ id: 'old-1' }, { id: 'old-2' }] });
    const svc = new ShadowEvaluatorService(db as never);

    const olderThanMs = 1000;
    const before = Date.now() - olderThanMs;
    const count = await svc.pruneObservations(olderThanMs);
    expect(count).toBe(2);

    expect(captured.deletedWhere).toHaveLength(1);
    const tokens = collectSqlTokens(captured.deletedWhere[0]);
    expect(tokens.names).toContain('created_at');
    const cutoffParam = tokens.params
      .map((p) => (p.startsWith('Invalid') ? null : new Date(p)))
      .find((d): d is Date => d != null && !Number.isNaN(d.getTime()));
    expect(cutoffParam).toBeDefined();
    expect(cutoffParam!.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(cutoffParam!.getTime()).toBeLessThanOrEqual(before + 5000);
  });

  it('listObservations 返回 fake 行并按过滤条件构建查询', async () => {
    const rows = [
      { id: 'o1', orgId: 'orgA', predictionType: 'task_duration', prediction: 30 },
      { id: 'o2', orgId: 'orgA', predictionType: 'task_duration', prediction: 40 },
    ];
    const { db, captured } = makeDb({ selectRows: rows });
    const svc = new ShadowEvaluatorService(db as never);

    const result = await svc.listObservations(orgA, {
      predictionType: 'task_duration',
      limit: 10,
      offset: 0,
    });
    expect(result).toHaveLength(2);
    expect(captured.selectWhere[0]).toBeDefined();
    const tokens = collectSqlTokens(captured.selectWhere[0]);
    expect(tokens.names).toContain('prediction_type');
    expect(tokens.params).toContain('task_duration');
  });

  it('无 db：aggregatePersisted 回退内存聚合；pruneObservations 返回 0；listObservations 返回 []', async () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample(
      { modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 30, baseline: 40, confidence: 0.9, createdAt: NOW },
      orgA,
    );
    svc.backfillActual('task_duration', 20, NOW, orgA);
    expect(await svc.aggregatePersisted(orgA)).toEqual(svc.aggregate(orgA));
    expect(await svc.pruneObservations(1000)).toBe(0);
    expect(await svc.listObservations(orgA)).toEqual([]);
  });
});
