/* P1-6（§六）Replan guard production fail-closed。
 *
 * 覆盖：
 *  - 用例 1：production（EWOH_DEPLOY_TARGET=production）下 advisory-lock 执行异常
 *    （mock db.execute 抛错）→ handleTrigger 返回 blocked（不创建 run、不求值、不求解），
 *    不静默降级内存守卫。
 *  - 用例 2：production 下 handleConflictBatch 同样 fail-closed（blocked）。
 *  - 用例 3：production 下降级同时上报 metric（scheduler_replan_guard_degraded_total）
 *    与 readiness 状态（ReplanGuardStatusService 记录 degradation）。
 *  - 用例 4：非 production（缺省）保留 memory fallback（显式断言不 blocked；与
 *    replan-multi-instance 用例 2 一致）。
 *  - 用例 5：production 下"锁未获得"（acquired=false）路径不变 → suppressed（非 blocked）。
 *  - 用例 6：MANUAL 触发在 production 下绕过守卫（人工重排始终放行）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import { SchedulerMetricsService } from '../scheduler-metrics.service';
import { ReplanGuardStatusService } from '../../health/replan-guard-status.service';
import {
  buildSnapshot, fakeRunWhereBuilder
} from './scheduler-test-helpers';

const ORIGINAL_DEPLOY_TARGET = process.env.EWOH_DEPLOY_TARGET;

/** 构造 ReplanCoordinatorService（每个实例独立内存态；metrics/guardStatus 可选注入）。 */
function makeReplanInstance(opts: {
  db: Record<string, unknown>;
  replan: {
    replanDebounceMs: number;
    minimumReplanIntervalMs: number;
    maximumReplansPerWindow: number;
    conflictAggregationWindowMs: number;
  };
  evaluate?: jest.Mock;
  metrics?: SchedulerMetricsService;
  guardStatus?: ReplanGuardStatusService;
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
    opts.metrics as never,
    undefined,
    opts.guardStatus as never,
  );
  return { svc, triggerService, solverService };
}

/** 缩短窗口以便快速连续触发（与 replan-multi-instance 一致）。 */
const SHORT_CONFIG = {
  replanDebounceMs: 0,
  minimumReplanIntervalMs: 5,
  maximumReplansPerWindow: 2,
  conflictAggregationWindowMs: 60_000,
};

/** db.update 最小链（成功路径 run 状态闭合）。 */
function makeUpdateChain() {
  return jest.fn(() => ({
    set: jest.fn(() => ({ where: jest.fn(() => fakeRunWhereBuilder()) })),
  }));
}

/** mock db：execute 抛错（advisory lock 不可用）。 */
function makeThrowingDb() {
  return {
    execute: jest.fn(() => {
      throw new Error('execute not supported by fake db');
    }),
    update: makeUpdateChain(),
  };
}

describe('P1-6 Replan guard production fail-closed', () => {
  afterEach(() => {
    if (ORIGINAL_DEPLOY_TARGET === undefined) {
      delete process.env.EWOH_DEPLOY_TARGET;
    } else {
      process.env.EWOH_DEPLOY_TARGET = ORIGINAL_DEPLOY_TARGET;
    }
  });

  it('用例 1：production 下 advisory-lock 异常 → handleTrigger fail-closed（blocked，不创建 run/不求解）', async () => {
    process.env.EWOH_DEPLOY_TARGET = 'production';
    const db = makeThrowingDb();
    const { svc, triggerService, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const r = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/fail-closed/);
    expect(r.run).toBeNull();
    expect(r.plans).toEqual([]);
    expect(r.suppressed).toBeFalsy();
    expect(r.debounced).toBeFalsy();
    // 不静默降级内存态：triggerService 未求值、solver 未求解。
    expect(triggerService.evaluate).not.toHaveBeenCalled();
    expect(solverService.solveVariants).not.toHaveBeenCalled();
    // 每次守卫判定都尝试过锁（显式降级而非静默跳过）。
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('用例 2：production 下 advisory-lock 异常 → handleConflictBatch fail-closed（blocked）', async () => {
    process.env.EWOH_DEPLOY_TARGET = 'production';
    const db = makeThrowingDb();
    const { svc, triggerService, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const r = await svc.handleConflictBatch(['RSV-1'], ['T-1'], ctx);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/fail-closed/);
    expect(r.run).toBeNull();
    expect(r.plans).toEqual([]);
    expect(triggerService.evaluate).not.toHaveBeenCalled();
    expect(solverService.solveVariants).not.toHaveBeenCalled();
  });

  it('用例 3：production 下降级上报 metric（scheduler_replan_guard_degraded_total）与 readiness 状态', async () => {
    process.env.EWOH_DEPLOY_TARGET = 'production';
    const metrics = new SchedulerMetricsService();
    const guardStatus = new ReplanGuardStatusService();
    const { svc } = makeReplanInstance({
      db: makeThrowingDb(),
      replan: SHORT_CONFIG,
      metrics,
      guardStatus,
    });

    const r = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });
    expect(r.blocked).toBe(true);
    expect(metrics.snapshot()['scheduler_replan_guard_degraded_total']).toBe(1);
    expect(metrics.renderMetrics()).toContain('scheduler_replan_guard_degraded_total 1');
    const status = guardStatus.getStatus();
    expect(status.state).toBe('degraded');
    expect(status.reason).toMatch(/execute not supported/);
    expect(status.lastDegradationAt).toEqual(expect.any(String));
  });

  it('用例 4：非 production（缺省）advisory-lock 异常 → memory fallback（不 blocked，与现状一致）', async () => {
    delete process.env.EWOH_DEPLOY_TARGET;
    const db = makeThrowingDb();
    const metrics = new SchedulerMetricsService();
    const { svc, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
      metrics,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    // 前 2 次允许（窗口=2），第 3 次（距上次 < minInterval 且窗口已满）→ 抑制。
    const r1 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r2 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r3 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r1.blocked).toBeFalsy();
    expect(r2.blocked).toBeFalsy();
    expect(r3.suppressed).toBe(true);
    expect(r3.blocked).toBeFalsy();
    expect(solverService.solveVariants).toHaveBeenCalledTimes(2);
    // 非 production 同样上报降级 metric（可观测，不得 silent fallback）。
    expect(metrics.snapshot()['scheduler_replan_guard_degraded_total']).toBe(3);
  });

  it('用例 5：production 下锁未获得（acquired=false）→ suppressed（非 blocked，路径不变）', async () => {
    process.env.EWOH_DEPLOY_TARGET = 'production';
    const db = {
      execute: jest.fn(() => Promise.resolve([{ acquired: false }])),
      update: makeUpdateChain(),
    };
    const { svc, triggerService, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const r = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r.suppressed).toBe(true);
    expect(r.blocked).toBeFalsy();
    expect(r.run).toBeNull();
    expect(r.plans).toEqual([]);
    expect(triggerService.evaluate).not.toHaveBeenCalled();
    expect(solverService.solveVariants).not.toHaveBeenCalled();
  });

  it('用例 6：production 下 MANUAL 触发绕过守卫（人工重排始终放行）', async () => {
    process.env.EWOH_DEPLOY_TARGET = 'production';
    const db = makeThrowingDb();
    const { svc, triggerService, solverService } = makeReplanInstance({
      db,
      replan: SHORT_CONFIG,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const r = await svc.handleTrigger('MANUAL', null, ctx);
    expect(r.blocked).toBeFalsy();
    expect(r.suppressed).toBeFalsy();
    expect(r.run).not.toBeNull();
    expect(triggerService.evaluate).toHaveBeenCalledTimes(1);
    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    // MANUAL 不尝试 advisory lock。
    expect(db.execute).not.toHaveBeenCalled();
  });
});
