import { EligibilityService, type EligiblePerson, type EligibleTask } from '../eligibility.service';
import { SchedulerController } from '../scheduler.controller';
import { makePlanService, testOrgContext } from './dispatch-test-harness';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
  makeEligibilityCtx,
} from './scheduler-test-helpers';
import type { SchedulingPlanV2 } from '@shared/api.interface';

function eligibleTask(t: ReturnType<typeof seedTask>) {
  return {
    id: t.id,
    taskType: t.taskType,
    requiredSkills: t.requiredSkills,
    requiredCertifications: t.requiredCertifications,
    stationId: t.stationId,
    zoneId: t.zoneId,
    predIds: t.predecessorIds,
  };
}

function eligiblePerson(p: ReturnType<typeof seedPerson>) {
  return {
    id: p.id,
    status: p.status,
    skills: p.skills,
    certifications: p.certifications,
    stationId: p.stationId,
    loadLevel: p.loadLevel,
    fatigueLevel: p.fatigueLevel,
    healthStatus: p.healthStatus,
  };
}

const person: EligiblePerson = eligiblePerson(seedPerson({ id: 'p1' }));
const svc = new EligibilityService();

describe('Task 1.4 requiredDeviceCapabilities 硬约束', () => {
  it('设备在线且电量充足但缺能力 → 不可用（missing_device_capability）', () => {
    const res = svc.check(
      person,
      { ...eligibleTask(seedTask({ id: 't1' })), requiredDeviceCapabilities: ['vacuum'] },
      { id: 'd1', batteryPct: 100, online: true, status: 'online', capabilities: ['exo-lift'] },
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('missing_device_capability');
    expect(res.reasons).not.toContain('battery_low');
    expect(res.reasons).not.toContain('device_offline');
  });

  it('设备具备所需能力 → 可通过能力校验', () => {
    const res = svc.check(
      person,
      { ...eligibleTask(seedTask({ id: 't1' })), requiredDeviceCapabilities: ['vacuum'] },
      { id: 'd1', batteryPct: 100, online: true, status: 'online', capabilities: ['vacuum'] },
      makeEligibilityCtx(),
    );
    expect(res.reasons).not.toContain('missing_device_capability');
    expect(res.eligible).toBe(true);
  });

  it('求解器：缺能力设备不派（能力要求任务无可行设备 → 不产生 assignment）', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [{ ...seedTask({ id: 't1' }), requiredDeviceCapabilities: ['vacuum'] }],
        devices: [{ ...seedDevice({ id: 'd1' }), capabilities: ['exo-lift'] }],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 't1', reason: 'no_eligible_resource' }),
      ]),
    );
  });

  it('求解器：具备能力设备被选用', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [{ ...seedTask({ id: 't1' }), requiredDeviceCapabilities: ['vacuum'] }],
        devices: [{ ...seedDevice({ id: 'd1' }), capabilities: ['vacuum'] }],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].deviceId).toBe('d1');
  });
});

describe('Task 1.5 DecisionTrace 生成 + JSONB 持久化', () => {
  it('求解器为每个 assignment 生成可解释决策轨迹', async () => {
    const { solver } = makeSolver();
    const policy = defaultPolicy();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy },
    );
    const dt = plan.assignments[0].decisionTrace;
    expect(dt).toBeDefined();
    expect(dt!.taskId).toBe('t1');
    expect(dt!.selected.personId).toBe('p1');
    expect(dt!.selected.deviceId).toBe('d1');
    expect(dt!.policyVersion).toBe(policy.version);
    expect(dt!.solverVersion).toBe(policy.solverVersion);
    expect(dt!.snapshotVersion).toBe(baseSolveOpts.snapshotVersion);
    expect(Array.isArray(dt!.candidates)).toBe(true);
    expect(Array.isArray(dt!.rejectedAlternatives)).toBe(true);
    expect(dt!.priority.factors.length).toBeGreaterThan(0);
  });

  it('DecisionTrace persist → getPlan 读回一致', async () => {
    const { svc: planSvc } = makePlanService({});
    const decisionTrace = {
      taskId: 'T-1',
      selected: { personId: 'p1', deviceId: 'd1', stationId: null },
      priority: {
        level: '2',
        score: 200,
        factors: [{ key: 'base_priority', label: 'base_priority', value: 200 }],
      },
      candidates: [
        { personId: 'p1', deviceId: 'd1', stationId: null, score: 10, reasons: ['ok'] },
      ],
      selectedReason: ['ok'],
      rejectedAlternatives: [],
      policyVersion: 7,
      solverVersion: 'heuristic-v2',
      snapshotVersion: 'WS-RT-0001',
    };
    const plan: SchedulingPlanV2 = {
      planId: 'PLAN-DT',
      planName: 'dt',
      version: 1,
      status: 'shadow',
      trigger: { type: 'MANUAL', entityId: null },
      snapshotVersion: 'WS-RT-0001',
      policyVersion: 7,
      solverVersion: 'heuristic-v2',
      horizonMinutes: 480,
      assignments: [
        {
          assignmentId: 'ASG-DT',
          taskId: 'T-1',
          personId: 'p1',
          deviceId: 'd1',
          stationId: null,
          zoneId: null,
          plannedStart: '2026-08-07T00:00:00.000Z',
          plannedEnd: '2026-08-07T01:00:00.000Z',
          routeId: null,
          status: 'proposed',
          reasons: ['ok'],
          alternatives: [],
          decisionTrace,
        },
      ],
      metrics: {
        lateMinutes: 0,
        walkingMeters: 0,
        stationWaitMinutes: 0,
        maxWorkload: 0,
        changeCost: 0,
      },
      baselineDelta: {},
      violations: [],
      createdAt: '2026-08-07T00:00:00.000Z',
    };

    await planSvc.persistPlan(plan, testOrgContext());
    const readBack = await planSvc.getPlan('PLAN-DT');
    expect(readBack.assignments[0].decisionTrace).toEqual(decisionTrace);
  });
});

describe('Task 1.6 Top-K 多方案来自版本化策略权重', () => {
  it('两个变体权重不同 → 产生不同分配，且差异可解释（标签/权重）', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', load: 0.55 }), seedPerson({ id: 'p2', load: 0.1 })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, baselineAssignee: new Map([['t1', 'p1']]) },
    );

    expect(plan).toHaveLength(3);
    // 不同标签（可解释）
    expect(plan[0].planName).toBe('准时优先');
    expect(plan[1].planName).toBe('负荷均衡');
    expect(plan[0].planName).not.toBe(plan[1].planName);

    // 每个变体携带策略版本与原因/权重（可解释）
    expect(plan[0].policyVersion).toBe(defaultPolicy().version);
    const v0 = plan[0].baselineDelta.variant as any;
    const v1 = plan[1].baselineDelta.variant as any;
    expect(v0).toBeDefined();
    expect(v1).toBeDefined();
    expect(v0.label).toBe('准时优先');
    expect(v1.label).toBe('负荷均衡');
    expect(v0.weights.latenessWeight).toBeGreaterThan(v1.weights.latenessWeight);
    expect(v0.weights.workloadBalanceWeight).toBeLessThan(v1.weights.workloadBalanceWeight);

    // 不同权重 → 不同分配（准时优先选基线人员 p1，负荷均衡选低负荷 p2）
    const a1 = plan[0].assignments[0].personId;
    const b1 = plan[1].assignments[0].personId;
    expect(a1).toBe('p1');
    expect(b1).toBe('p2');
    expect(a1).not.toBe(b1);
  });
});

describe('Task 1.7 废弃 legacy scheduler/plans API', () => {
  function makeController() {
    const schedulerService = {
      generatePlans: jest.fn().mockResolvedValue([{ planId: 'P1' }]),
      getPlans: jest.fn().mockResolvedValue([]),
      confirmPlan: jest.fn().mockResolvedValue({ plan: { planId: 'P1' }, audit: {} }),
    };
    const stream = { start: jest.fn(), events: jest.fn() };
    const ctrl = new SchedulerController(
      schedulerService as unknown as import('../scheduler.service').SchedulerService,
      stream as unknown as import('../scheduler-stream.service').SchedulerStreamService,
    );
    return { ctrl, schedulerService };
  }

  it('legacy POST /plans 经适配器正常委派并返回废弃提示', async () => {
    const { ctrl, schedulerService } = makeController();
    const res: any = await ctrl.generatePlans({});
    expect(schedulerService.generatePlans).toHaveBeenCalled();
    expect(res.deprecated).toBe(true);
    expect(res.data).toEqual([{ planId: 'P1' }]);
    expect(res.suggestedV2).toBe('POST /api/scheduler/runs');
  });

  it('legacy POST /plans/:planId/confirm 经适配器委派并返回废弃提示', async () => {
    const { ctrl, schedulerService } = makeController();
    const res: any = await ctrl.confirmPlan(
      'P1',
      { reason: 'ok' },
      { userContext: testOrgContext() },
    );
    expect(schedulerService.confirmPlan).toHaveBeenCalled();
    expect(res.deprecated).toBe(true);
    expect(res.data.plan.planId).toBe('P1');
    expect(res.suggestedV2).toBe('POST /api/scheduler/plans/:planId/approve');
  });

  it('V2 路径（createRun/getPlanDetail）不携带废弃标记', async () => {
    const schedulerService: any = {
      createRun: jest.fn().mockResolvedValue({ runId: 'R1' }),
      getPlanDetail: jest.fn().mockResolvedValue({ planId: 'P1' }),
    };
    const stream = { start: jest.fn(), events: jest.fn() };
    const ctrl = new SchedulerController(
      schedulerService,
      stream as unknown as import('../scheduler-stream.service').SchedulerStreamService,
    );
    const run: any = await ctrl.createRun({}, { userContext: testOrgContext() });
    expect(run).toEqual({ runId: 'R1' });
    expect(run.deprecated).toBeUndefined();
    const detail: any = await ctrl.getPlan('P1');
    expect(detail).toEqual({ planId: 'P1' });
    expect(detail.deprecated).toBeUndefined();
  });
});