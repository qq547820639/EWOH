import { PlanService } from '../plan.service';
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
    buildSnapshot: jest.fn(),
  };
  const dispatchCoordinator = { dispatch: jest.fn() };
  const schedulingPolicyService = {
    getActivePolicy: jest.fn(),
    getPolicy: jest.fn(),
    getConfig: jest.fn(),
    getConfigByVersion: jest.fn(),
  };

  const svc = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solverService as unknown as SolverService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    dispatchCoordinator as unknown as DispatchCoordinatorService,
    schedulingPolicyService as unknown as SchedulingPolicyService,
  );

  return {
    svc,
    state,
    mocks: {
      requestDatabaseContext,
      auditService,
      solverService,
      worldStateSnapshotService,
      dispatchCoordinator,
      schedulingPolicyService,
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