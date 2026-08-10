/* P0-5 Replan storm guard 跨实例一致性。
 *
 * 覆盖：
 *  - 用例 1：advisory lock 可用——首个实例（Pod A）获得 org 级守卫权（守卫事务打开期间），
 *    第二个实例（Pod B）pg_try_advisory_xact_lock 返回未获得 → guard 返回 suppressed，
 *    不创建 run、不执行重排；A 放行后正常重排。
 *  - 用例 2：advisory lock 不可用（mock db execute 抛错）→ 显式降级回内存态，
 *    行为与 replan-storm 现状完全一致（窗口打满后第三次触发被抑制）。
 *  - 用例 3：durable 幂等——同一 (org, triggerType, entityId) 重复触发被
 *    ewoh_replan_trigger.triggerKey 唯一键（已存在检查 + 唯一约束硬后盾 23505）拦截，
 *    不创建重复 run（TriggerService.evaluate 真实逻辑）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import { TriggerService } from '../trigger.service';
import { ewohReplanTrigger, ewohSchedulingRun } from '@server/database/schema';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { buildSnapshot } from './scheduler-test-helpers';

/** 构造带可配置 replan 风暴配置的 ReplanCoordinatorService（每个实例独立内存态）。 */
function makeReplanInstance(opts: {
  db: Record<string, unknown>;
  replan: {
    replanDebounceMs: number;
    minimumReplanIntervalMs: number;
    maximumReplansPerWindow: number;
    conflictAggregationWindowMs: number;
  };
  evaluate?: jest.Mock;
}) {
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
  const triggerService = {
    evaluate:
      opts.evaluate ??
      jest.fn().mockResolvedValue({
        runId: 'RUN-1',
        triggerType: 'DEVICE_OFFLINE',
        triggerEntityId: 'd1',
        status: 'queued',
        snapshotVersion: null,
        planIds: [],
        orgId: 'org1',
        error: null,
        createdAt: new Date().toISOString(),
      }),
  };
  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(buildSnapshot({ tasks: [] })),
  };
  const solverService = {
    solveVariants: jest.fn().mockResolvedValue([
      {
        planId: 'RUN-1A',
        version: 1,
        status: 'shadow',
        trigger: { type: 'DEVICE_OFFLINE', entityId: 'd1' },
        snapshotVersion: 'WS-TEST-0001',
        policyVersion: 1,
        solverVersion: 'heuristic-v2',
        horizonMinutes: 480,
        assignments: [],
        metrics: {},
        baselineDelta: {},
        violations: [],
        createdAt: new Date().toISOString(),
      },
    ]),
  };
  const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
  const policyService = {
    getConfig: jest.fn().mockResolvedValue({
      configVersion: 1,
      triggerCooldownMs: 1,
      priority: {},
      replan: opts.replan,
    }),
  };

  const svc = new ReplanCoordinatorService(
    opts.db as never,
    requestDatabaseContext as never,
    triggerService as never,
    worldStateSnapshotService as never,
    solverService as never,
    planService as never,
    policyService as never,
    undefined,
    undefined,
    undefined,
  );
  return { svc, triggerService, solverService };
}

/** 缩短窗口以便快速连续触发（避免真实 sleep），与 replan-storm 一致。 */
const SHORT_CONFIG = {
  replanDebounceMs: 0,
  minimumReplanIntervalMs: 5,
  maximumReplansPerWindow: 2,
  conflictAggregationWindowMs: 60_000,
};

/** db.update 最小链（handleTrigger 成功路径 run 状态闭合）。 */
function makeUpdateChain() {
  return jest.fn(() => ({
    set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
  }));
}

describe('P0-5 跨实例守卫权（advisory lock 可用）', () => {
  it('用例 1：第二实例尝试时未获得锁 → guard 返回 suppressed，不执行重排', async () => {
    // 集群级 advisory lock 协调器：A 获得后持有，直到测试放行（模拟 A 守卫事务打开/处理中）。
    let lockHeld = false;
    let releaseA: (() => void) | null = null;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // Pod A：首个 execute 获得锁（守卫事务挂起直到 gate 放行）。
    const dbA = {
      execute: jest.fn(() => {
        if (!lockHeld) {
          lockHeld = true;
          return gateA.then(() => [{ acquired: true }]);
        }
        return Promise.resolve([{ acquired: false }]);
      }),
      update: makeUpdateChain(),
    };
    // Pod B：同 org 尝试获取守卫权 → 未获得（A 正持有）。
    const dbB = {
      execute: jest.fn(() => Promise.resolve([{ acquired: false }])),
      update: makeUpdateChain(),
    };

    const ctx = { userId: 'u1', primaryOrgId: 'org1' };
    const { svc: svcA, solverService: solverA, triggerService: triggerA } =
      makeReplanInstance({ db: dbA, replan: SHORT_CONFIG });
    const { svc: svcB, solverService: solverB, triggerService: triggerB } =
      makeReplanInstance({ db: dbB, replan: SHORT_CONFIG });

    // A 的守卫事务在同步前缀已执行 execute 并持有锁（gate 未放行，A 仍在守卫中）。
    const pA = svcA.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);

    try {
      // B（另一实例）此刻尝试 → pg_try_advisory_xact_lock 返回未获得 → 抑制。
      const rB = await svcB.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
      expect(rB.suppressed).toBe(true);
      expect(rB.run).toBeNull();
      expect(rB.plans).toEqual([]);
      // 抑制先于 triggerService 求值：B 不创建 run、不求解。
      expect(triggerB.evaluate).not.toHaveBeenCalled();
      expect(solverB.solveVariants).not.toHaveBeenCalled();
      expect(svcB.getSuppressedCount('org1')).toBe(1);
    } finally {
      // 无论断言是否通过都放行 A 的守卫事务，避免 gate promise 挂起泄漏。
      releaseA!();
    }

    // 放行 A → A 获得守卫权后正常重排。
    const rA = await pA;
    expect(rA.suppressed).toBeFalsy();
    expect(rA.run).not.toBeNull();
    expect(triggerA.evaluate).toHaveBeenCalledTimes(1);
    expect(solverA.solveVariants).toHaveBeenCalledTimes(1);
  });
});

describe('P0-5 降级路径（advisory lock 不可用）', () => {
  it('用例 2：mock db execute 抛错 → 显式降级回内存态，行为与 replan-storm 现状一致', async () => {
    const db = {
      execute: jest.fn(() => {
        throw new Error('execute not supported by fake db');
      }),
      update: makeUpdateChain(),
    };
    const { svc, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    // 前 2 次允许（窗口=2），第 3 次（距上次 < minInterval 且窗口已满）→ 抑制。
    const r1 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r2 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r3 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r1.suppressed).toBeFalsy();
    expect(r2.suppressed).toBeFalsy();
    expect(r3.suppressed).toBe(true);
    expect(r3.run).toBeNull();
    expect(r3.plans).toEqual([]);
    expect(solverService.solveVariants).toHaveBeenCalledTimes(2);
    expect(svc.getSuppressedCount('org1')).toBe(1);
    // 每次守卫判定都尝试过锁（3 次），全部显式降级而非静默跳过。
    expect(db.execute).toHaveBeenCalledTimes(3);
  });
});

describe('P0-5 durable 幂等（ewoh_replan_trigger.triggerKey 唯一键）', () => {
  /** ewohReplanTrigger / ewohSchedulingRun 最小 fake db（TriggerService.evaluate 真实路径）。 */
  function makeTriggerDb(opts: { dedupBlind?: boolean }) {
    const triggerRows: Array<Record<string, unknown>> = [];
    let selectNo = 0;
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => {
            // 冷却查询走 orderBy→limit；去重查询直接 limit（两条链共享同一 limit 计数）。
            const limit = jest.fn(() => {
              selectNo += 1;
              if (selectNo % 2 === 1) return Promise.resolve([]); // 冷却查询：恒无最近触发（cooldownMs=0）
              // 幂等去重查询：模拟 triggerKey 已存在检查。
              if (opts.dedupBlind) return Promise.resolve([]); // 竞态窗口：存在性检查未命中
              return Promise.resolve([...triggerRows].reverse().slice(0, 1));
            });
            return { orderBy: jest.fn(() => ({ limit })), limit };
          }),
        })),
      })),
      insert: jest.fn((table: unknown) => ({
        values: (values: unknown) => {
          if (table === ewohReplanTrigger) {
            const v = values as Record<string, unknown>;
            if (triggerRows.some((r) => r.triggerKey === v.triggerKey)) {
              // 唯一约束硬后盾：并发同键插入被拦截（23505）。evaluate 对 trigger
              // 插入只 await values(...)，故在此直接 reject。
              return Promise.reject(
                Object.assign(
                  new Error(
                    'duplicate key value violates unique constraint "ewoh_replan_trigger_trigger_key_key"',
                  ),
                  { code: '23505' },
                ),
              );
            }
            triggerRows.push({ ...v, createdAt: new Date() });
            return Promise.resolve([]);
          }
          if (table === ewohSchedulingRun) {
            return {
              returning: () =>
                Promise.resolve([{ ...(values as Record<string, unknown>) }]),
            };
          }
          return Promise.resolve([]);
        },
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    };
    return { db, triggerRows };
  }

  function makeTriggerService(db: Record<string, unknown>) {
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const policyService = {
      getConfig: jest.fn().mockResolvedValue({ triggerCooldownMs: 0 }),
    };
    const svc = new TriggerService(
      db as never,
      requestDatabaseContext as never,
      policyService as never,
    );
    return svc;
  }

  it('用例 3a：同一 (org, triggerType, entityId) 顺序重复触发被已存在检查拦截（不创建重复 run）', async () => {
    const { db } = makeTriggerDb({ dedupBlind: false });
    const svc = makeTriggerService(db);
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const first = await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);
    expect(first).not.toBeNull();
    expect(first!.runId).toMatch(/^RUN-/);
    // 仅 1 条 ewoh_replan_trigger、1 条 run 被插入。
    expect(db.insert).toHaveBeenCalledTimes(2); // 1 × trigger + 1 × run

    // 同键重复触发：存在性检查命中 → 返回 null（幂等抑制，无新 run）。
    const second = await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);
    expect(second).toBeNull();
    // 第二次 evaluate 未再插入任何行（仍只有 2 次 insert）。
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('用例 3b：并发竞态窗口下重复插入被唯一约束（23505）拦截，不创建重复 run', async () => {
    const { db } = makeTriggerDb({ dedupBlind: true });
    const svc = makeTriggerService(db);
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);

    // 模拟另一实例已提交同 triggerKey（存在性检查被盲化），再次插入撞唯一约束。
    await expect(svc.evaluate('DEVICE_OFFLINE', 'd1', ctx)).rejects.toMatchObject({
      code: '23505',
    });
    // 冲突发生在 ewoh_replan_trigger 插入处：从未创建第二个 run。
    const insertTargets = db.insert.mock.calls.map((c) => c[0]);
    expect(insertTargets.filter((t) => t === ewohSchedulingRun)).toHaveLength(1);
  });

  it('replan-coordinator 侧：triggerService 去重（evaluate 返回 null）→ handleTrigger 不创建 run', async () => {
    // 同一 (org, triggerType, entityId) 重复触发由 durable 层（TriggerService）抑制：
    // coordinator 收到 run=null 时返回 debounced（不重排、不求解）。
    const db = { update: makeUpdateChain() };
    const evaluate = jest.fn().mockResolvedValue(null); // durable 幂等命中
    const { svc, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
      evaluate,
    });

    const r = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });
    expect(r.run).toBeNull();
    expect(r.debounced).toBe(true);
    expect(solverService.solveVariants).not.toHaveBeenCalled();
  });
});
