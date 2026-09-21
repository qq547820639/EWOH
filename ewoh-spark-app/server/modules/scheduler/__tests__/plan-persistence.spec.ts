import { PlanService, isPlanIdUniqueViolation } from '../plan.service';
import { ConflictException } from '@nestjs/common';
import { ewohSchedulePlan } from '@server/database/schema';
import { SolverService } from '../solver.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { DispatchCoordinatorService } from '../dispatch-coordinator.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  SchedulingPolicy,
  ScoreBreakdown,
} from '@shared/api.interface';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import type { SchedulingFeedbackService } from '../scheduling-feedback.service';

function scoreBreakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    lateness: 0,
    travel: 10,
    workloadBalance: 5,
    stationWait: 0,
    changeCost: 0,
    risk: 2,
    energyCost: 1,
    ...overrides,
    total: overrides.total ?? 18,
  };
}

function fullPlan(): SchedulingPlanV2 {
  return {
    planId: 'PLAN-RT',
    planName: 'roundtrip',
    version: 3,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: 'src-1' },
    snapshotVersion: 'WS-RT-0001',
    policyVersion: 7,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 360,
    assignments: [
      fullAssignment(),
    ],
    metrics: {
      lateMinutes: 0,
      walkingMeters: 100,
      stationWaitMinutes: 0,
      maxWorkload: 1,
      changeCost: 0,
    },
    scoreBreakdown: scoreBreakdown({ total: 18 }),
    baselineDelta: { lateMinutesDelta: 0 },
    violations: [{ taskId: 'T-1', reason: 'low_battery', type: 'warning' }],
    createdAt: '2026-08-07T00:00:00.000Z',
  };
}

function fullAssignment(): SchedulingAssignment {
  return {
    assignmentId: 'ASG-RT',
    taskId: 'T-1',
    personId: 'p1',
    deviceId: 'd1',
    stationId: null,
    zoneId: null,
    plannedStart: '2026-08-07T00:00:00.000Z',
    plannedEnd: '2026-08-07T01:00:00.000Z',
    routeId: 'R-1',
    status: 'proposed',
    reasons: ['low_battery'],
    alternatives: [{ personId: 'p2', reasons: ['high_load'] }],
    etaSeconds: 120,
    distanceMeters: 100,
    riskLevel: 'low',
    scoreBreakdown: scoreBreakdown({ travel: 10, total: 18 }),
  };
}

function makePolicy(version: number): SchedulingPolicy {
  return {
    version,
    latenessWeight: 3,
    walkingWeight: 1,
    workloadBalanceWeight: 1,
    stationWaitWeight: 1,
    changeCostWeight: 0.5,
    riskWeight: 1,
    energyWeight: 0.5,
    solverVersion: 'heuristic-v2',
    weights: { lateness: 3, travel: 1, wait: 1, workload: 1, station: 1, change: 0.5, risk: 1, energy: 0.5 },
  };
}

function makePlanServiceWith(seed: Parameters<typeof makeFakeDb>[0]) {
  const { db, state } = makeFakeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const solverService = { solve: jest.fn(), solveVariants: jest.fn() };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
    assertFreshForWave: jest.fn().mockResolvedValue(undefined),
    buildSnapshot: jest.fn(),
  };
  const dispatchCoordinator = { dispatch: jest.fn() };
  const schedulingPolicyService = {
    getActivePolicy: jest.fn(),
    getPolicy: jest.fn(),
    getConfig: jest.fn(),
    getConfigByVersion: jest.fn(),
  };
  const constraintLoaderService = {
    loadForPlan: jest.fn(async (_planId: string, requestConstraints: any[]) => requestConstraints),
    hashConstraints: jest.fn().mockReturnValue('hash'),
  };
  const feedbackService = { recordAcceptance: jest.fn(), recordBaseline: jest.fn() };

  const svc = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solverService as unknown as SolverService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    dispatchCoordinator as unknown as DispatchCoordinatorService,
    schedulingPolicyService as unknown as SchedulingPolicyService,
    feedbackService as unknown as SchedulingFeedbackService,
    constraintLoaderService as never,
    { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'stale_plan', entityId: 'x', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as never,
    { handleTrigger: jest.fn() } as never,
  );

  return {
    svc,
    db,
    state,
    mocks: {
      requestDatabaseContext,
      auditService,
      solverService,
      worldStateSnapshotService,
      dispatchCoordinator,
      schedulingPolicyService,
      constraintLoaderService,
      feedbackService,
    },
  };
}

describe('Task 0.5 完整持久化 SchedulingPlanV2 + round-trip', () => {
  it('persist → getPlan 后 policyVersion/solverVersion/horizonMinutes/scoreBreakdown 与写入一致（非硬编码）', async () => {
    const { svc } = makePlanServiceWith({});
    const plan = fullPlan();
    await svc.persistPlan(plan, testOrgContext());

    const readBack = await svc.getPlan('PLAN-RT');
    expect(readBack.policyVersion).toBe(7);
    expect(readBack.solverVersion).toBe('heuristic-v2');
    expect(readBack.horizonMinutes).toBe(360);
    expect(readBack.scoreBreakdown).toEqual(plan.scoreBreakdown);

    const a = readBack.assignments[0];
    expect(a.etaSeconds).toBe(120);
    expect(a.distanceMeters).toBe(100);
    expect(a.riskLevel).toBe('low');
    expect(a.scoreBreakdown).toEqual(plan.assignments[0].scoreBreakdown);
    expect(a.reasons).toEqual(plan.assignments[0].reasons);
    expect(a.alternatives).toEqual(plan.assignments[0].alternatives);

    // 其余语义字段保持一致
    expect(readBack.version).toBe(plan.version);
    expect(readBack.trigger).toEqual(plan.trigger);
    expect(readBack.snapshotVersion).toBe(plan.snapshotVersion);
    expect(readBack.metrics).toEqual(plan.metrics);
    expect(readBack.violations).toEqual(plan.violations);
    expect(readBack.baselineDelta).toEqual(plan.baselineDelta);
  });

  it('旧数据（列缺失为 null）回退默认值，不使用写入时的硬编码', async () => {
    const { svc } = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-OLD',
          planName: 'old',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 1,
          snapshotVersion: 'WS-OLD',
          policyVersion: null,
          solverVersion: null,
          horizonMinutes: null,
          scoreBreakdownJson: null,
        },
      ],
      assignments: [],
      tasks: [],
    });
    const readBack = await svc.getPlan('PLAN-OLD');
    expect(readBack.policyVersion).toBe(1);
    expect(readBack.solverVersion).toBe('heuristic-v2');
    expect(readBack.horizonMinutes).toBe(480);
    expect(readBack.scoreBreakdown).toBeUndefined();
  });
});

describe('Task 0.6 Replan 继承真实策略', () => {
  it('replan 传给 solver 的 policy 来自原方案 policyVersion（而非 weight=1 假策略）', async () => {
    const { svc, mocks } = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-SRC',
          planName: 'src',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 2,
          snapshotVersion: 'WS-1',
          policyVersion: 7,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 360,
        },
      ],
      assignments: [],
      tasks: [],
    });

    const inheritedPolicy = makePolicy(7);
    mocks.schedulingPolicyService.getPolicy.mockResolvedValue(inheritedPolicy);
    mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LATEST',
    });
    mocks.solverService.solve.mockResolvedValue(fullPlan());

    await svc.replan(
      'PLAN-SRC',
      { lockedConstraints: [] },
      testOrgContext(),
    );

    expect(mocks.schedulingPolicyService.getPolicy).toHaveBeenCalledWith(7);
    expect(mocks.schedulingPolicyService.getPolicy).not.toHaveBeenCalledWith(null);
    const opts = mocks.solverService.solve.mock.calls[0][2];
    expect(opts.policy).toBe(inheritedPolicy);
    expect(opts.policy.version).toBe(7);
    expect(opts.horizonMinutes).toBe(360);
    expect(opts.snapshotVersion).toBe('WS-LATEST');
  });

  it('原方案 policyVersion 为 null（旧数据）时回退 active policy', async () => {
    const { svc, mocks } = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-LEGACY',
          planName: 'legacy',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 1,
          snapshotVersion: 'WS-1',
          policyVersion: null,
          solverVersion: null,
          horizonMinutes: null,
        },
      ],
      assignments: [],
      tasks: [],
    });

    const activePolicy = makePolicy(3);
    mocks.schedulingPolicyService.getActivePolicy.mockResolvedValue(activePolicy);
    mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LATEST',
    });
    mocks.solverService.solve.mockResolvedValue(fullPlan());

    await svc.replan('PLAN-LEGACY', { lockedConstraints: [] }, testOrgContext());

    expect(mocks.schedulingPolicyService.getPolicy).not.toHaveBeenCalled();
    expect(mocks.schedulingPolicyService.getActivePolicy).toHaveBeenCalled();
    const opts = mocks.solverService.solve.mock.calls[0][2];
    expect(opts.policy).toBe(activePolicy);
    expect(opts.horizonMinutes).toBe(480); // 旧数据无 horizon → 默认 480
  });

  it('targetPolicyVersion 显式指定时使用该策略并记录 audit 说明', async () => {
    const { svc, mocks, state } = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-SRC',
          planName: 'src',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 2,
          snapshotVersion: 'WS-1',
          policyVersion: 7,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 360,
        },
      ],
      assignments: [],
      tasks: [],
    });

    const targetPolicy = makePolicy(9);
    mocks.schedulingPolicyService.getPolicy.mockResolvedValue(targetPolicy);
    mocks.schedulingPolicyService.getConfigByVersion.mockResolvedValue({
      configVersion: 9,
      horizonMinutes: 540,
    });
    mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LATEST',
    });
    mocks.solverService.solve.mockResolvedValue(fullPlan());

    await svc.replan(
      'PLAN-SRC',
      { lockedConstraints: [], targetPolicyVersion: 9 },
      testOrgContext(),
    );

    expect(mocks.schedulingPolicyService.getPolicy).toHaveBeenCalledWith(9);
    const opts = mocks.solverService.solve.mock.calls[0][2];
    expect(opts.policy).toBe(targetPolicy);
    expect(opts.horizonMinutes).toBe(540);

    // audit 记录带 targetPolicyVersion 说明
    expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('v9'),
      }),
    );
    expect(state.audits.length).toBeGreaterThan(0);
    expect(state.audits[0].reason).toContain('v9');
  });
});

describe('Task 3: 手动资源操作 → SchedulingConstraint 触发重排', () => {
  it('提交 LOCKED_PERSON 约束触发重排，约束传给 solver 且新方案遵守锁定', async () => {
    const { svc, mocks, state } = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-SRC',
          planName: 'src',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 2,
          snapshotVersion: 'WS-1',
          policyVersion: 7,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 360,
        },
      ],
      assignments: [],
      tasks: [],
    });

    const inheritedPolicy = makePolicy(7);
    mocks.schedulingPolicyService.getPolicy.mockResolvedValue(inheritedPolicy);
    mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LATEST',
    });
    // 求解器收到 LOCKED_PERSON 后产出 personId=p2 的方案（遵守锁定）。
    const lockedPlan: SchedulingPlanV2 = {
      ...fullPlan(),
      planId: 'PLAN-SRC-R3',
      version: 3,
    };
    lockedPlan.assignments = [{ ...fullAssignment(), personId: 'p2' }];
    mocks.solverService.solve.mockResolvedValue(lockedPlan);

    const result = await svc.replan(
      'PLAN-SRC',
      {
        lockedConstraints: [{ type: 'LOCKED_PERSON', taskId: 'T-1', personId: 'p2' }],
        operator: 'u1',
        reason: '资源池手动分配',
      },
      testOrgContext(),
    );

    // 1) 约束被传给 solver（而非二次调度路径）。
    const constraintsPassed = mocks.solverService.solve.mock.calls[0][1];
    expect(constraintsPassed).toEqual([
      expect.objectContaining({ type: 'LOCKED_PERSON', taskId: 'T-1', personId: 'p2' }),
    ]);

    // 2) 新方案遵守锁定。
    expect(result.planId).toBe('PLAN-SRC-R3');
    expect(result.assignments[0].personId).toBe('p2');

    // 3) 约束被落库为 scheduling_constraint（personId 存于 valueJson）。
    const persisted = state.constraints.find(
      (c) =>
        (c as { type?: string }).type === 'LOCKED_PERSON' &&
        (c.valueJson as { personId?: string } | undefined)?.personId === 'p2',
    );
    expect(persisted).toBeDefined();
    expect(persisted!.type).toBe('LOCKED_PERSON');
    expect(persisted!.active).toBe(true);
    expect((persisted!.valueJson as { personId?: string }).personId).toBe('p2');
  });
});

describe('并发 replan：plan_id 唯一键竞态 → 409（E2E concurrency-real-pg J3 对齐）', () => {
  /** 模拟 drizzle DrizzleQueryError：原生 postgres 错误挂 cause（带 code/constraint_name）。 */
  function drizzleUniqueViolation(constraintName: string): Error {
    const cause = Object.assign(
      new Error(
        `duplicate key value violates unique constraint "${constraintName}"`,
      ),
      { code: '23505', constraint_name: constraintName },
    );
    const err = new Error(
      `Failed query: insert into "ewoh_schedule_plan" (...) — duplicate key value violates unique constraint "${constraintName}"`,
    );
    (err as { cause?: unknown }).cause = cause;
    return err;
  }

  function seedReplanRace() {
    const handle = makePlanServiceWith({
      plans: [
        {
          planId: 'PLAN-SRC',
          planName: 'src',
          strategy: 'scheduling_v2',
          status: 'approved',
          version: 1,
          snapshotVersion: 'WS-1',
          policyVersion: 7,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 360,
        },
      ],
      assignments: [],
      tasks: [],
    });
    handle.mocks.schedulingPolicyService.getPolicy.mockResolvedValue(
      makePolicy(7),
    );
    handle.mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LATEST',
    });
    handle.mocks.solverService.solve.mockResolvedValue(fullPlan());
    return handle;
  }

  it('isPlanIdUniqueViolation 识别直接挂 code 与 cause 包装两种 23505 形态', () => {
    expect(
      isPlanIdUniqueViolation(drizzleUniqueViolation('ewoh_schedule_plan_plan_id_key')),
    ).toBe(true);
    expect(
      isPlanIdUniqueViolation(
        Object.assign(new Error('dup'), {
          code: '23505',
          constraint_name: 'ewoh_schedule_plan_plan_id_key',
        }),
      ),
    ).toBe(true);
    // 非该表唯一键 / 非唯一键错误 → 不识别
    expect(
      isPlanIdUniqueViolation(drizzleUniqueViolation('ewoh_idempotency_keys_org_scope_key')),
    ).toBe(false);
    expect(isPlanIdUniqueViolation(Object.assign(new Error('x'), { code: '23P01' }))).toBe(false);
    expect(isPlanIdUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('replan 撞 plan_id 唯一键（23505）→ ConflictException，而非裸驱动错误当 500', async () => {
    const { svc, db, state } = seedReplanRace();
    const originalInsert = db.insert.bind(db);
    (db as { insert: unknown }).insert = (table: unknown) => {
      if (table === ewohSchedulePlan) {
        // persistPlan 形态：await db.insert(...).values(...)（无 returning），
        // 桩以 rejected promise 使 await 抛出。
        return {
          values: () =>
            Promise.reject(drizzleUniqueViolation('ewoh_schedule_plan_plan_id_key')),
        };
      }
      return originalInsert(table);
    };

    await expect(
      svc.replan('PLAN-SRC', { lockedConstraints: [] }, testOrgContext()),
    ).rejects.toBeInstanceOf(ConflictException);

    // 竞态输家事务中止：原方案不被本请求标记 superseded（由赢家负责）
    expect(state.plans.get('PLAN-SRC')?.status).toBe('approved');
  });

  it('其他唯一键冲突（非 plan_id）不被误映射，原样抛出', async () => {
    const { svc, db } = seedReplanRace();
    const originalInsert = db.insert.bind(db);
    const rawError = drizzleUniqueViolation('uq_some_other_table_key');
    (db as { insert: unknown }).insert = (table: unknown) => {
      if (table === ewohSchedulePlan) {
        return {
          values: () => Promise.reject(rawError),
        };
      }
      return originalInsert(table);
    };

    await expect(
      svc.replan('PLAN-SRC', { lockedConstraints: [] }, testOrgContext()),
    ).rejects.toBe(rawError);
  });
});
describe('PlanService lifecycle CAS', () => {
  const lifecycleSeed = () => ({
    plans: [{
      planId: 'PLAN-LIFE',
      status: 'proposed',
      version: 2,
      snapshotVersion: 'WS-1',
      orgId: 'org1',
      isShadow: false,
    }],
    assignments: [{
      assignmentId: 'ASG-LIFE',
      planId: 'PLAN-LIFE',
      taskId: 'T-1',
      orgId: 'org1',
      status: 'proposed',
      version: 1,
    }],
  });

  it('approvePlan persists an approved transition from proposed and preserves version CAS inputs', async () => {
    const { svc, state, mocks } = makePlanServiceWith(lifecycleSeed());
    mocks.worldStateSnapshotService.buildSnapshot.mockResolvedValue({
      snapshotVersion: 'WS-LIVE',
      tasks: [],
      lockedAssignments: [],
    });
    mocks.feedbackService.recordAcceptance.mockResolvedValue(undefined);
    const approved = await svc.approvePlan(
      'PLAN-LIFE',
      { version: 2, snapshotVersion: 'WS-1' },
      testOrgContext(),
    );
    expect(approved.status).toBe('approved');
    expect(state.plans.get('PLAN-LIFE')?.status).toBe('approved');
    expect(state.assignments[0].status).toBe('approved');
  });

  it('rejects approval of a dispatched plan before any transactional update', async () => {
    const seed = lifecycleSeed();
    seed.plans[0].status = 'dispatched';
    const { svc } = makePlanServiceWith(seed);
    await expect(
      svc.approvePlan('PLAN-LIFE', { version: 2, snapshotVersion: 'WS-1' }, testOrgContext()),
    ).rejects.toThrow('PLAN_NOT_APPROVABLE');
  });
});
