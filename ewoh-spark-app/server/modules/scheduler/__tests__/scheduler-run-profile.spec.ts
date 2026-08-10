/* Task 6（scheduler-phase0-truth-context / P0-6）：createRun 接口增强单测。
 *
 * 覆盖：objectiveProfile 指定时只产出对应 profile 变体；mode=SHADOW 不 persist plan；
 * 未提供 objectiveProfile 时保持 A/B/C 三变体现状（回归）；baselinePlanId 作为 churn 基线。
 *
 * 遵循 constraint-run-loading.spec.ts 的 mock 风格：fake db（update 链可捕获 set 参数）。
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SolverService } from '../solver.service';
import { ConstraintLoaderService } from '../constraint-loader.service';
import { ewohSchedulingRun } from '@server/database/schema';
import { testOrgContext } from './dispatch-test-harness';
import type { SchedulingPlanV2, WorldStateSnapshot } from '@shared/api.interface';

function makeSnapshot(): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };
}

function planVariant(suffix: string): SchedulingPlanV2 {
  return {
    planId: `RUN-1${suffix}`,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-TEST-0001',
    policyVersion: 1,
    solverVersion: 'test',
    horizonMinutes: 480,
    assignments: [],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

/** 构造 createRun 所需最小依赖；返回 mocks 供断言。 */
function makeSvc(overrides: { plans?: SchedulingPlanV2[]; baselinePlan?: SchedulingPlanV2 } = {}) {
  const db: any = {
    update: jest.fn(() => ({
      set: jest.fn((values: unknown) => ({
        where: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
        __setValues: values,
      })),
    })),
  };
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const triggerService = {
    evaluate: jest.fn().mockResolvedValue({
      runId: 'RUN-1',
      triggerType: 'MANUAL',
      triggerEntityId: null,
    }),
  };
  const solverService = {
    solve: jest.fn(),
    solveVariants: jest.fn().mockResolvedValue(
      overrides.plans ?? [planVariant('A'), planVariant('B'), planVariant('C')],
    ),
  };
  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
  };
  const planService = {
    persistPlan: jest.fn().mockResolvedValue(undefined),
    getPlan: jest.fn().mockResolvedValue(
      overrides.baselinePlan ?? {
        planId: 'PLAN-BASE',
        assignments: [{ taskId: 't1', personId: 'p1' }, { taskId: 't2', personId: 'p2' }],
      },
    ),
  };
  const policyService = {
    getActivePolicy: jest.fn(),
    getPolicy: jest.fn(),
    getConfig: jest.fn(),
    getConfigByVersion: jest.fn(),
  };
  const constraintLoaderService = {
    loadGlobalActive: jest.fn().mockResolvedValue([]),
  };

  const svc = new SchedulerService(
    db,
    requestDatabaseContext as never,
    auditService as never,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    triggerService as never,
    solverService as unknown as SolverService,
    planService as unknown as PlanService,
    { loadGraph: jest.fn(), calculateRoute: jest.fn() } as never,
    { check: jest.fn() } as never,
    { estimate: jest.fn() } as never,
    policyService as never,
    { deriveKpis: jest.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  (svc as unknown as { constraintLoaderService?: ConstraintLoaderService }).constraintLoaderService =
    constraintLoaderService as never;

  return { svc, db, mocks: { planService, solverService, constraintLoaderService } };
}

/** 从 fake db 捕获 createRun 末尾 update ewohSchedulingRun 的 set 参数。 */
function lastRunUpdateSet(db: any): Record<string, unknown> | null {
  const updateCalls = db.update.mock.calls as unknown[][];
  // 定位对 ewohSchedulingRun 的 update（第一个 update 调用即 run 状态更新）。
  if (updateCalls.length === 0) return null;
  const setMock = db.update.mock.results[0].value.set;
  return setMock.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('P0-6: createRun objectiveProfile / mode / baselinePlanId', () => {
  it('objectiveProfile=on_time → 只产出 A 变体并持久化（singleProfile 语义）', async () => {
    const { svc, mocks } = makeSvc();

    const res = await svc.createRun(
      { trigger: 'MANUAL', objectiveProfile: 'on_time' },
      testOrgContext(),
    );

    expect(res.plans.map((p) => p.planId)).toEqual(['RUN-1A']);
    // 仅 A 变体被 persist。
    expect(mocks.planService.persistPlan).toHaveBeenCalledTimes(1);
    expect((mocks.planService.persistPlan as jest.Mock).mock.calls[0][0].planId).toBe('RUN-1A');
  });

  it('objectiveProfile=load_balance → B；composite → C', async () => {
    const { svc } = makeSvc();
    const bal = await svc.createRun({ trigger: 'MANUAL', objectiveProfile: 'load_balance' }, testOrgContext());
    expect(bal.plans.map((p) => p.planId)).toEqual(['RUN-1B']);

    const { svc: svc2 } = makeSvc();
    const comp = await svc2.createRun({ trigger: 'MANUAL', objectiveProfile: 'composite' }, testOrgContext());
    expect(comp.plans.map((p) => p.planId)).toEqual(['RUN-1C']);
  });

  it('未提供 objectiveProfile → 保持 A/B/C 三变体现状（回归）', async () => {
    const { svc, mocks } = makeSvc();

    const res = await svc.createRun({ trigger: 'MANUAL' }, testOrgContext());

    expect(res.plans).toHaveLength(3);
    expect(res.plans.map((p) => p.planId)).toEqual(['RUN-1A', 'RUN-1B', 'RUN-1C']);
    expect(mocks.planService.persistPlan).toHaveBeenCalledTimes(3);
  });

  it('objectiveProfile 未识别（min_disruption/distance 等）→ 回退三变体现状', async () => {
    const { svc } = makeSvc();
    const res = await svc.createRun({ trigger: 'MANUAL', objectiveProfile: 'min_disruption' }, testOrgContext());
    expect(res.plans).toHaveLength(3);
  });

  it('mode=SHADOW → 不 persist plan，run.planIds=[]（shadow 仅评估）', async () => {
    const { svc, db, mocks } = makeSvc();

    const res = await svc.createRun({ trigger: 'MANUAL', mode: 'SHADOW' }, testOrgContext());

    // 返回形状不变：plans 仍为求解结果（评估输出），但未写正式表。
    expect(res.plans).toHaveLength(3);
    expect(mocks.planService.persistPlan).not.toHaveBeenCalled();
    // run 标记 succeeded 且 planIds=[]。
    expect(db.update).toHaveBeenCalledWith(ewohSchedulingRun);
    const set = lastRunUpdateSet(db);
    expect(set?.status).toBe('succeeded');
    expect(set?.planIds).toEqual([]);
    expect(set?.snapshotVersion).toBe('WS-TEST-0001');
  });

  it('mode 缺省（MANUAL）→ 正式写入 planIds（回归）', async () => {
    const { svc, db } = makeSvc();
    await svc.createRun({ trigger: 'MANUAL' }, testOrgContext());
    const set = lastRunUpdateSet(db);
    expect(set?.planIds).toEqual(['RUN-1A', 'RUN-1B', 'RUN-1C']);
  });

  it('mode=SHADOW + objectiveProfile=on_time 组合 → 单变体且不 persist', async () => {
    const { svc, mocks } = makeSvc();
    const res = await svc.createRun(
      { trigger: 'MANUAL', mode: 'SHADOW', objectiveProfile: 'load_balance' },
      testOrgContext(),
    );
    expect(res.plans.map((p) => p.planId)).toEqual(['RUN-1B']);
    expect(mocks.planService.persistPlan).not.toHaveBeenCalled();
  });

  it('baselinePlanId → solveVariants 收到 baselineAssignee（taskId → personId）', async () => {
    const { svc, mocks } = makeSvc();

    await svc.createRun({ trigger: 'MANUAL', baselinePlanId: 'PLAN-BASE' }, testOrgContext());

    const args = (mocks.solverService.solveVariants as jest.Mock).mock.calls[0];
    const opts = args[2] as { baselineAssignee?: Map<string, string | null> };
    expect(opts.baselineAssignee).toBeInstanceOf(Map);
    expect(opts.baselineAssignee?.get('t1')).toBe('p1');
    expect(opts.baselineAssignee?.get('t2')).toBe('p2');
  });

  it('baselinePlanId 读取失败 → 降级空基线，不阻断求解', async () => {
    const { svc, mocks } = makeSvc();
    (mocks.planService.getPlan as jest.Mock).mockRejectedValue(new Error('plan not found'));

    const res = await svc.createRun({ trigger: 'MANUAL', baselinePlanId: 'PLAN-MISSING' }, testOrgContext());

    expect(res.plans).toHaveLength(3); // 求解仍正常
    const opts = (mocks.solverService.solveVariants as jest.Mock).mock.calls[0][2] as {
      baselineAssignee?: Map<string, string | null>;
    };
    expect(opts.baselineAssignee).toBeUndefined();
  });
});
