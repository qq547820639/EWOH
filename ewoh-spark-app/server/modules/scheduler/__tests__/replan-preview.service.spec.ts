/* Incremental Replan V2 / M03：Replan Preview（08 §5） + 审批政策（08 §6）。
 *
 * 覆盖：preview 只读（不落库不派工）；计数正确（affected/unchanged/changed/added/removed）；
 * Delta 字段齐全；approval 判定（critical/lock/ratio 命中 → HUMAN_APPROVAL_REQUIRED；
 * soft 且不命中 → AUTO_REPLAN）。
 */
/// <reference types="jest" />
import { ReplanPreviewService } from '../replan-preview.service';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import { PlanCompareService } from '../plan-compare.service';
import { PlanService } from '../plan.service';
import type {
  ReplanImpact,
  ReplanPreviewResult,
  SchedulingPlanV2,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { testOrgContext } from './dispatch-test-harness';
import { buildSnapshot, defaultPolicy, defaultConfig } from './scheduler-test-helpers';

function makeSnapshot(): WorldStateSnapshot {
  return buildSnapshot({
    persons: [
      { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: 0, y: 0 },
      { id: 'p2', name: 'p2', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: 5, y: 0 },
    ],
    tasks: [
      { id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending', assigneeId: 'p1', deviceId: null, stationId: null, zoneId: null, planStart: null, planEnd: null, progress: 0, predecessorIds: [], requiredSkills: ['work'], requiredCertifications: [] },
      { id: 't2', title: 't2', taskType: 'work', priority: 'medium', status: 'pending', assigneeId: 'p2', deviceId: null, stationId: null, zoneId: null, planStart: null, planEnd: null, progress: 0, predecessorIds: [], requiredSkills: ['work'], requiredCertifications: [] },
    ],
    devices: [],
    stations: [],
    lockedAssignments: [],
  });
}

function makePlan(id: string): SchedulingPlanV2 {
  return {
    planId: id,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-TEST-0001',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

function makeService() {
  const persistedPlans: string[] = [];
  const planService = {
    listActivePlans: jest.fn().mockResolvedValue([makePlan('PLAN-BASE')]),
    persistPlan: jest.fn().mockImplementation(async (p: SchedulingPlanV2) => {
      persistedPlans.push(p.planId);
    }),
    getPlan: jest.fn().mockResolvedValue(makePlan('PLAN-BASE')),
    consultReplanApproval: jest.fn(),
  };
  const solverService = {
    solve: jest.fn(),
    solveVariants: jest.fn().mockResolvedValue([
      {
        ...makePlan('PREVIEW-X'),
        planId: 'PREVIEW-X',
        assignments: [
          { assignmentId: 'ASG-1', taskId: 't1', personId: 'p2', deviceId: null, stationId: null, zoneId: null, plannedStart: new Date().toISOString(), plannedEnd: new Date(Date.now() + 3600000).toISOString(), status: 'proposed', reasons: [], alternatives: [], etaSeconds: 10, distanceMeters: 10 },
        ],
        metrics: { lateMinutes: 5, walkingMeters: 120, stationWaitMinutes: 2, maxWorkload: 0.5, changeCost: 1 },
        scoreBreakdown: { lateness: 5, travel: 10, workloadBalance: 0, stationWait: 2, changeCost: 1, risk: 0, energyCost: 0, total: 18 },
      },
    ]),
  };
  const worldState = {
    buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
  };
  const constraintLoader = {
    loadGlobalActive: jest.fn().mockResolvedValue([]),
    loadForPlan: jest.fn().mockResolvedValue([]),
    hashConstraints: jest.fn(() => 'hash'),
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue({ ...defaultConfig(), replanApproval: { autoMaxAffectedRatio: 0.5, autoMaxChurnRatio: 0.4, requireApprovalOnSafetyCritical: true, requireApprovalOnHumanLock: true } }),
    resolveReplanApprovalConfig: jest.fn().mockResolvedValue({ autoMaxAffectedRatio: 0.5, autoMaxChurnRatio: 0.4, requireApprovalOnSafetyCritical: true, requireApprovalOnHumanLock: true }),
    resolveReplanConfig: jest.fn().mockResolvedValue(defaultConfig().replan),
  };
  const db = { update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })) })) };
  const requestDatabaseContext = { runInTransaction: jest.fn(async (_g: unknown, fn: () => Promise<void>) => fn()) };
  const triggerService = {
    evaluate: jest.fn().mockResolvedValue({ runId: 'RUN-P', triggerType: 'DEVICE_OFFLINE', triggerEntityId: 'd1', status: 'queued', snapshotVersion: null, planIds: [], orgId: 'org1', error: null, createdAt: new Date().toISOString() }),
  };
  const planCompare = new PlanCompareService();
  const replanCoordinator = new ReplanCoordinatorService(
    db as never,
    requestDatabaseContext as never,
    triggerService as never,
    worldState as never,
    solverService as never,
    planService as never,
    policyService as never,
  );
  const svc = new ReplanPreviewService(
    replanCoordinator,
    solverService as never,
    worldState as never,
    constraintLoader as never,
    planCompare,
    planService as never,
  );
  return { svc, persistedPlans, mocks: { planService, solverService, planCompare }, replanCoordinator };
}

/** 构造真实 PlanService（consultReplanApproval 决策逻辑），仅 mock 外部依赖。 */
function makePlanServiceForApproval(configOverride: Record<string, unknown> = {}) {
  const worldState = {
    buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
    // P1（2026-08-19 审计）：consultReplanApproval 改走只读快照——mock 同步。
    buildSnapshotReadOnly: jest.fn().mockResolvedValue(makeSnapshot()),
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
  };
  const policyService = {
    resolveReplanApprovalConfig: jest.fn().mockResolvedValue({
      autoMaxAffectedRatio: 0.5,
      autoMaxChurnRatio: 0.4,
      requireApprovalOnSafetyCritical: true,
      requireApprovalOnHumanLock: true,
      ...configOverride,
    }),
  };
  const planService = new PlanService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    worldState as never,
    {} as never,
    policyService as never,
    { recordAcceptance: jest.fn(), recordBaseline: jest.fn() } as never,
    { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
    { handleTrigger: jest.fn() } as never,
  );
  return planService;
}

describe('M03 ReplanPreviewService', () => {
  it('preview 返回 readonly + 完整 Delta 字段 + 计数', async () => {
    const { svc } = makeService();
    const res = await svc.previewReplan('DEVICE_OFFLINE', ['d1'], testOrgContext());
    expect(res.readonly).toBe(true);
    expect(res.candidatePlanId).toMatch(/^PREVIEW-/);
    expect(res).toHaveProperty('affectedTaskCount');
    expect(res).toHaveProperty('unchangedAssignmentCount');
    expect(res).toHaveProperty('changedAssignmentCount');
    expect(res).toHaveProperty('addedAssignmentCount');
    expect(res).toHaveProperty('removedAssignmentCount');
    expect(res).toHaveProperty('latenessDelta');
    expect(res).toHaveProperty('travelDelta');
    expect(res).toHaveProperty('workloadDelta');
    expect(res).toHaveProperty('stationWaitDelta');
    expect(res).toHaveProperty('changeoverDelta');
    expect(res).toHaveProperty('energyRiskDelta');
    expect(res).toHaveProperty('riskDelta');
    expect(res).toHaveProperty('churnDelta');
    expect(Array.isArray(res.changedAssignments)).toBe(true);
  });

  it('preview 只读：不落库（无 persistPlan）、不派工（solveVariants 候选仅内存）', async () => {
    const { svc, persistedPlans, mocks } = makeService();
    await svc.previewReplan('DEVICE_OFFLINE', ['d1'], testOrgContext());
    expect(persistedPlans).toEqual([]);
    expect(mocks.planService.persistPlan).not.toHaveBeenCalled();
  });

  it('preview 计数：affected 集合正确（t1 受设备影响，t2 无关）', async () => {
    const { svc } = makeService();
    const snapshot = makeSnapshot();
    // 构造带 device 的 seed：t1 挂 d1（受影响），t2 不挂。
    const withDevice = buildSnapshot({
      ...snapshot,
      tasks: snapshot.tasks.map((t, i) =>
        i === 0 ? { ...t, deviceId: 'd1' } : t,
      ),
    });
    const worldStateOverride = { buildSnapshot: jest.fn().mockResolvedValue(withDevice), getCurrentWorldState: jest.fn().mockResolvedValue(withDevice) };
    const base = makeService();
    const svc2 = new ReplanPreviewService(
      base.replanCoordinator,
      base.mocks.solverService as never,
      worldStateOverride as never,
      { loadGlobalActive: jest.fn().mockResolvedValue([]) } as never,
      base.mocks.planCompare as never,
      base.mocks.planService as never,
    );
    const res = await svc2.previewReplan('DEVICE_OFFLINE', ['d1'], testOrgContext());
    expect(res.affectedTaskCount).toBe(1);
  });

  it('approval：critical_event（SAFETY_EVENT）→ HUMAN_APPROVAL_REQUIRED', async () => {
    const planService = makePlanServiceForApproval();
    const impact: ReplanImpact = {
      triggerType: 'SAFETY_EVENT',
      triggerIds: [],
      affectedTaskIds: ['t1'],
      affectedResourceIds: [],
      affectedPersonIds: [],
      affectedDeviceIds: [],
      affectedStationIds: [],
      affectedZoneIds: [],
      frozenAssignmentIds: [],
      movableAssignmentIds: ['t1'],
      reasons: ['critical_event:SAFETY_EVENT'],
      snapshotVersion: 'WS-TEST-0001',
      baselinePlanVersion: null,
    };
    const out = await planService.consultReplanApproval({
      triggerType: 'SAFETY_EVENT',
      impact,
      preview: null,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(out.reasons).toContain('critical_event');
  });

  it('approval：soft 且不命中（PERSON_UNAVAILABLE 低比例）→ AUTO_REPLAN', async () => {
    const planService = makePlanServiceForApproval();
    const impact: ReplanImpact = {
      triggerType: 'PERSON_UNAVAILABLE',
      triggerIds: [],
      affectedTaskIds: ['t1'],
      affectedResourceIds: [],
      affectedPersonIds: ['p1'],
      affectedDeviceIds: [],
      affectedStationIds: [],
      affectedZoneIds: [],
      frozenAssignmentIds: [],
      movableAssignmentIds: ['t1'],
      reasons: ['soft_deviation:PERSON_UNAVAILABLE:p1'],
      snapshotVersion: 'WS-TEST-0001',
      baselinePlanVersion: null,
    };
    const out = await planService.consultReplanApproval({
      triggerType: 'PERSON_UNAVAILABLE',
      impact,
      preview: null,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('AUTO_REPLAN');
  });

  it('approval：含人工 LOCK → HUMAN_APPROVAL_REQUIRED（requireApprovalOnHumanLock）', async () => {
    const planService = makePlanServiceForApproval();
    const impact: ReplanImpact = {
      triggerType: 'DEVICE_OFFLINE',
      triggerIds: ['d1'],
      affectedTaskIds: ['t-lock'],
      affectedResourceIds: [],
      affectedPersonIds: [],
      affectedDeviceIds: ['d1'],
      affectedStationIds: [],
      affectedZoneIds: [],
      frozenAssignmentIds: ['t-lock'],
      movableAssignmentIds: [],
      reasons: ['hard_conflict:DEVICE_OFFLINE:d1'],
      snapshotVersion: 'WS-TEST-0001',
      baselinePlanVersion: null,
    };
    // 覆盖 worldState：t-lock 在 lockedAssignments 中。
    const worldState = {
      buildSnapshot: jest.fn().mockResolvedValue(
        buildSnapshot({
          tasks: [
            { id: 't-lock', title: 't-lock', taskType: 'work', priority: 'medium', status: 'executing', assigneeId: 'p1', deviceId: 'd1', stationId: null, zoneId: null, planStart: null, planEnd: null, progress: 0, predecessorIds: [], requiredSkills: ['work'], requiredCertifications: [] },
          ],
          lockedAssignments: [{ taskId: 't-lock', personId: 'p1', deviceId: 'd1', stationId: null }],
        }),
      ),
      // P1（2026-08-19 审计）：consultReplanApproval 改走只读快照——mock 同步。
      buildSnapshotReadOnly: jest.fn().mockResolvedValue(
        buildSnapshot({
          tasks: [
            { id: 't-lock', title: 't-lock', taskType: 'work', priority: 'medium', status: 'executing', assigneeId: 'p1', deviceId: 'd1', stationId: null, zoneId: null, planStart: null, planEnd: null, progress: 0, predecessorIds: [], requiredSkills: ['work'], requiredCertifications: [] },
          ],
          lockedAssignments: [{ taskId: 't-lock', personId: 'p1', deviceId: 'd1', stationId: null }],
        }),
      ),
      getCurrentWorldState: jest.fn(),
    };
    const policyService = {
      resolveReplanApprovalConfig: jest.fn().mockResolvedValue({
        autoMaxAffectedRatio: 0.5,
        autoMaxChurnRatio: 0.4,
        requireApprovalOnSafetyCritical: true,
        requireApprovalOnHumanLock: true,
      }),
    };
    const svc = new PlanService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      worldState as never,
      {} as never,
      policyService as never,
      { recordAcceptance: jest.fn(), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
      { handleTrigger: jest.fn() } as never,
    );
    const out = await svc.consultReplanApproval({
      triggerType: 'DEVICE_OFFLINE',
      impact,
      preview: null,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(out.reasons).toContain('human_lock');
  });

  /** 软触发 + 纯计数型 preview（不命中 critical/ratio/lock/lateness 等其余维度）。 */
  function softImpactPreview(
    changed: number,
    added: number,
    removed: number,
  ): { impact: ReplanImpact; preview: ReplanPreviewResult } {
    const impact: ReplanImpact = {
      triggerType: 'PERSON_UNAVAILABLE',
      triggerIds: [],
      affectedTaskIds: ['t1'],
      affectedResourceIds: [],
      affectedPersonIds: ['p1'],
      affectedDeviceIds: [],
      affectedStationIds: [],
      affectedZoneIds: [],
      frozenAssignmentIds: [],
      movableAssignmentIds: ['t1'],
      reasons: ['soft_deviation:PERSON_UNAVAILABLE:p1'],
      snapshotVersion: 'WS-TEST-0001',
      baselinePlanVersion: null,
    };
    const preview: ReplanPreviewResult = {
      baselinePlanId: 'PLAN-BASE',
      candidatePlanId: 'PREVIEW-X',
      readonly: true,
      affectedTaskCount: 1,
      unchangedAssignmentCount: 0,
      changedAssignmentCount: changed,
      addedAssignmentCount: added,
      removedAssignmentCount: removed,
      latenessDelta: 0,
      travelDelta: 0,
      workloadDelta: 0,
      stationWaitDelta: 0,
      changeoverDelta: 0,
      energyRiskDelta: 0,
      riskDelta: 0,
      churnDelta: 0,
      changedAssignments: [],
    };
    return { impact, preview };
  }

  it('approval：改派总数超限（maxChangedAssignments=5，changed+added+removed=6）→ HUMAN_APPROVAL_REQUIRED', async () => {
    const planService = makePlanServiceForApproval({ maxChangedAssignments: 5 });
    const { impact, preview } = softImpactPreview(4, 1, 1);
    const out = await planService.consultReplanApproval({
      triggerType: 'PERSON_UNAVAILABLE',
      impact,
      preview,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(out.reasons).toContain('max_changed_assignments');
  });

  it('approval：改派总数未超限（maxChangedAssignments=5，=5）→ 不命中 max_changed_assignments', async () => {
    const planService = makePlanServiceForApproval({ maxChangedAssignments: 5 });
    const { impact, preview } = softImpactPreview(3, 1, 1);
    const out = await planService.consultReplanApproval({
      triggerType: 'PERSON_UNAVAILABLE',
      impact,
      preview,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('AUTO_REPLAN');
    expect(out.reasons).not.toContain('max_changed_assignments');
  });

  it('approval：maxChangedAssignments 缺省 20（=21 命中，=20 不命中）', async () => {
    const planService = makePlanServiceForApproval();
    const hit = softImpactPreview(10, 10, 1);
    const out = await planService.consultReplanApproval({
      triggerType: 'PERSON_UNAVAILABLE',
      impact: hit.impact,
      preview: hit.preview,
      ctx: testOrgContext(),
    });
    expect(out.decision).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(out.reasons).toContain('max_changed_assignments');

    const miss = softImpactPreview(10, 9, 1);
    const out2 = await planService.consultReplanApproval({
      triggerType: 'PERSON_UNAVAILABLE',
      impact: miss.impact,
      preview: miss.preview,
      ctx: testOrgContext(),
    });
    expect(out2.decision).toBe('AUTO_REPLAN');
    expect(out2.reasons).not.toContain('max_changed_assignments');
  });
});
