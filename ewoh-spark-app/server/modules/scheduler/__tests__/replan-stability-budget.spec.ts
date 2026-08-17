/* ReplanStabilityBudget（Task 5）：freezeWindowMinutes + minimumObjectiveImprovement。
 *
 * 覆盖：
 *  - freeze window：planStart 落在 [now-宽容, now+freezeWindowMinutes] 的已分配任务
 *    并入冻结集，且以 LOCKED_ASSIGNMENT 语义追加进 partialSnapshot.lockedAssignments；
 *    窗口外任务不受影响；缺省 15min 生效。
 *  - minimumObjectiveImprovement：非 critical 且无冲突/硬约束待修复、候选目标改进
 *    低于阈值 → suppressed=true、plan 不落盘、SSE reason=minimum_objective_improvement、
 *    run 闭合为 succeeded（planIds=[]）。
 *  - 绕过：SAFETY_EVENT（critical）与 best.violations 非空 → 正常 replan；缺省 2% 阈值生效。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
} from './scheduler-test-helpers';

/** 构造带可配置 replan 稳定性预算配置的 ReplanCoordinatorService。 */
function makeReplanService(opts: {
  snapshot: WorldStateSnapshot;
  replan?: Record<string, unknown>;
  latestPlanTotal?: number | null;
  candidateTotal?: number | null;
  violations?: Array<Record<string, unknown>>;
  outbox?: { enqueue: jest.Mock };
}) {
  // 捕获 run 更新 payload（断言抑制路径 planIds=[] / status=succeeded）。
  const setMock = jest.fn((_payload: Record<string, unknown>) => ({
    where: jest.fn(() => Promise.resolve()),
  }));
  const db = {
    update: jest.fn(() => ({ set: setMock })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        // ADR-071：loadLatestPlanObjective 按 org 过滤基线（where → orderBy → limit）。
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue(
              opts.latestPlanTotal != null
                ? [{ scoreBreakdownJson: { total: opts.latestPlanTotal } }]
                : [],
            ),
          })),
        })),
      })),
    })),
  };
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const triggerService = {
    evaluate: jest.fn().mockResolvedValue({
      runId: 'RUN-1',
      triggerType: 'ROUTE_BLOCKED',
      triggerEntityId: null,
      status: 'queued',
      snapshotVersion: null,
      planIds: [],
      orgId: 'org1',
      error: null,
      createdAt: new Date().toISOString(),
    }),
  };
  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(opts.snapshot),
  };
  const solverService = {
    solveVariants: jest.fn().mockResolvedValue([
      {
        planId: 'RUN-1A',
        version: 1,
        status: 'shadow',
        trigger: { type: 'ROUTE_BLOCKED', entityId: null },
        snapshotVersion: 'WS-TEST-0001',
        policyVersion: 1,
        solverVersion: 'heuristic-v2',
        horizonMinutes: 480,
        assignments: [],
        metrics: {},
        baselineDelta: {},
        violations: opts.violations ?? [],
        scoreBreakdown:
          opts.candidateTotal != null
            ? {
                lateness: 0,
                travel: 0,
                workloadBalance: 0,
                stationWait: 0,
                changeCost: 0,
                risk: 0,
                energyCost: 0,
                total: opts.candidateTotal,
              }
            : undefined,
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
      replan: {
        replanDebounceMs: 0,
        minimumReplanIntervalMs: 0,
        maximumReplansPerWindow: 12,
        conflictAggregationWindowMs: 60_000,
        maxPropagationDepth: 3,
        maxAffectedTasks: 200,
        ...opts.replan,
      },
    }),
  };

  const svc = new ReplanCoordinatorService(
    db as never,
    requestDatabaseContext as never,
    triggerService as never,
    worldStateSnapshotService as never,
    solverService as never,
    planService as never,
    policyService as never,
    undefined,
    undefined,
    opts.outbox as never,
  );
  return { svc, db, setMock, solverService, planService, triggerService };
}

const CTX = { userId: 'u1', primaryOrgId: 'org1' };

describe('ReplanStabilityBudget freeze window（Task 5）', () => {
  it('planStart 在 now+freezeWindowMinutes 内的已分配任务进入冻结集并追加 LOCKED_ASSIGNMENT', async () => {
    const now = Date.now();
    const soon = new Date(now + 5 * 60_000).toISOString(); // +5min（< 15min 窗口）
    const far = new Date(now + 60 * 60_000).toISOString(); // +60min（窗口外）
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      devices: [seedDevice({ id: 'd1' })],
      tasks: [
        // t-affected：DEVICE_OFFLINE 直接命中（受影响集；资源独立于 t-soon/t-far，避免闭包传播）。
        {
          ...seedTask({ id: 't-affected', planStart: far }),
          assigneeId: 'p1',
          deviceId: 'd1',
        },
        // t-soon：仅因 freeze window 进入子图（无 d1/无 p1 关联，不在受影响集）。
        { ...seedTask({ id: 't-soon', planStart: soon }), assigneeId: 'p2' },
        // t-far：窗口外且无关 → 不进子图、不进冻结集。
        { ...seedTask({ id: 't-far', planStart: far }), assigneeId: 'p2' },
      ],
    });
    const { svc, solverService } = makeReplanService({
      snapshot,
      replan: { freezeWindowMinutes: 15 },
    });

    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', CTX);

    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const ps = partialSnapshot as WorldStateSnapshot;
    const taskIds = ps.tasks.map((t: { id: string }) => t.id).sort();
    // t-soon 因冻结保留在子图；t-far（窗口外）不进入。
    expect(taskIds).toEqual(['t-affected', 't-soon']);
    // t-soon 当前分配以 LOCKED_ASSIGNMENT 语义追加（taskId 维度锁定，求解器不可移动）。
    expect(ps.lockedAssignments).toContainEqual({
      taskId: 't-soon',
      personId: 'p2',
      deviceId: null,
      stationId: null,
    });
    expect(ps.lockedAssignments).not.toContainEqual(
      expect.objectContaining({ taskId: 't-far' }),
    );
  });

  it('freezeWindowMinutes 缺省 15min 生效（planStart +5min 仍冻结）', async () => {
    const now = Date.now();
    const soon = new Date(now + 5 * 60_000).toISOString();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [
        { ...seedTask({ id: 't-soon', planStart: soon }), assigneeId: 'p1' },
      ],
    });
    const { svc, solverService } = makeReplanService({ snapshot });

    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', CTX);

    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const ps = partialSnapshot as WorldStateSnapshot;
    expect(ps.tasks.map((t: { id: string }) => t.id)).toContain('t-soon');
    expect(ps.lockedAssignments).toContainEqual({
      taskId: 't-soon',
      personId: 'p1',
      deviceId: null,
      stationId: null,
    });
  });
});

describe('ReplanStabilityBudget minimumObjectiveImprovement（Task 5）', () => {
  it('非 critical 且候选改进低于阈值 → 抑制（plan 不落盘、SSE reason、run 闭合）', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc, planService, setMock } = makeReplanService({
      snapshot: buildSnapshot({ tasks: [] }),
      replan: { minimumObjectiveImprovement: 0.5 },
      latestPlanTotal: 100,
      candidateTotal: 99, // 改进率 1% < 50% → 抑制
      outbox: { enqueue },
    });

    const r = await svc.handleTrigger('ROUTE_BLOCKED', 'E-1', CTX);

    expect(r.suppressed).toBe(true);
    // NEST-130（2026-08-17）：抑制路径返回 run 真实状态视图（DB 已闭合为
    // succeeded/planIds=[]，此前返回 null 与 DB 状态矛盾）。
    expect(r.run).toEqual(
      expect.objectContaining({ status: 'succeeded', planIds: [] }),
    );
    expect(r.plans).toEqual([]);
    expect(planService.persistPlan).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'replan.suppressed',
      expect.any(String),
      expect.objectContaining({
        triggerType: 'ROUTE_BLOCKED',
        reason: 'minimum_objective_improvement',
        suppressedAt: expect.any(String),
      }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
    // run 状态闭合为 succeeded、planIds=[]（未产生新方案）。
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', planIds: [] }),
    );
  });

  it('缺省 minimumObjectiveImprovement=0.02 生效（1% 改进被抑制）', async () => {
    const { svc, planService } = makeReplanService({
      snapshot: buildSnapshot({ tasks: [] }),
      latestPlanTotal: 100,
      candidateTotal: 99, // 改进率 1% < 2% → 抑制
    });

    const r = await svc.handleTrigger('ROUTE_BLOCKED', 'E-1', CTX);

    expect(r.suppressed).toBe(true);
    expect(planService.persistPlan).not.toHaveBeenCalled();
  });

  it('SAFETY_EVENT（critical）绕过目标门槛 → 正常 replan', async () => {
    const { svc, planService } = makeReplanService({
      snapshot: buildSnapshot({ tasks: [] }),
      replan: { minimumObjectiveImprovement: 0.5 },
      latestPlanTotal: 100,
      candidateTotal: 99,
    });

    const r = await svc.handleTrigger('SAFETY_EVENT', 'Z-1', CTX);

    expect(r.suppressed).toBeFalsy();
    expect(planService.persistPlan).toHaveBeenCalledTimes(1);
  });

  it('best.violations 非空（有硬约束待修复）绕过目标门槛 → 正常 replan', async () => {
    const { svc, planService } = makeReplanService({
      snapshot: buildSnapshot({ tasks: [] }),
      replan: { minimumObjectiveImprovement: 0.5 },
      latestPlanTotal: 100,
      candidateTotal: 99,
      violations: [{ type: 'hard_conflict', message: 'resource double book' }],
    });

    const r = await svc.handleTrigger('ROUTE_BLOCKED', 'E-1', CTX);

    expect(r.suppressed).toBeFalsy();
    expect(planService.persistPlan).toHaveBeenCalledTimes(1);
  });
});
