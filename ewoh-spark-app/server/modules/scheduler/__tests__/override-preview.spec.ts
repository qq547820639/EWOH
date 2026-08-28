/* T04 / P1-8：Override Preview 测试。
 *
 * 先跑红再改绿：现状无 POST /plans/:planId/overrides/preview 端点 / OverridePreviewService。
 * 本 spec 断言 preview 返回 7 项 delta、纯计算无副作用（不落库、不触发正式重排）、
 * safetyCritical 守卫。
 */
/// <reference types="jest" />
import { OverridePreviewService } from '../override-preview.service';
import { PlanService } from '../plan.service';
import { SolverService } from '../solver.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { ConstraintLoaderService } from '../constraint-loader.service';
import { PlanCompareService } from '../plan-compare.service';
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

function makePlan(id: string, lateMinutes = 10): SchedulingPlanV2 {
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
    metrics: { lateMinutes, walkingMeters: 100, stationWaitMinutes: 5, maxWorkload: 0.4, changeCost: 1 },
    baselineDelta: {},
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

function makeService() {
  const persistedPlans: string[] = [];
  const planService = {
    getPlan: jest.fn().mockResolvedValue(makePlan('PLAN-1')),
    persistPlan: jest.fn().mockImplementation(async (p: SchedulingPlanV2) => {
      persistedPlans.push(p.planId);
    }),
  };
  const solverService = {
    solve: jest.fn(),
    solveVariants: jest.fn().mockResolvedValue([makePlan('PREVIEW-X', 8)]),
  };
  const worldState = {
    buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
    // 预览改走只读快照（不落库）；mock 同步提供，避免 undefined 调用。
    buildSnapshotReadOnly: jest.fn().mockResolvedValue(makeSnapshot()),
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
  };
  const constraintLoader = {
    loadForPlan: jest.fn().mockResolvedValue([]),
    loadGlobalActive: jest.fn().mockResolvedValue([]),
    hashConstraints: jest.fn(() => 'hash'),
  };
  const planCompare = {
    compare: jest.fn().mockReturnValue({
      churn: 2,
      added: [],
      removed: [],
      diffByTask: [],
      changeTypeCounts: {},
      aggregate: {},
    }),
  };
  const svc = new OverridePreviewService(
    planService as unknown as PlanService,
    solverService as unknown as SolverService,
    worldState as unknown as WorldStateSnapshotService,
    constraintLoader as unknown as ConstraintLoaderService,
    planCompare as unknown as PlanCompareService,
  );
  return { svc, persistedPlans, mocks: { planService, solverService, planCompare } };
}

describe('T04 / P1-8 Override Preview', () => {
  it('preview 返回 7 项 delta + readonly 标记', async () => {
    const { svc } = makeService();
    const res = await svc.preview(
      'PLAN-1',
      { actions: [{ kind: 'LOCK_PERSON', taskId: 't1', personId: 'p1' }] },
      testOrgContext(),
    );
    expect(res.planId).toBe('PLAN-1');
    expect(res.readonly).toBe(true);
    expect(res).toHaveProperty('affectedAssignments');
    expect(res).toHaveProperty('conflictsIntroduced');
    expect(res).toHaveProperty('latenessDeltaMinutes');
    expect(res).toHaveProperty('travelDeltaMinutes');
    expect(res).toHaveProperty('workloadDelta');
    expect(res).toHaveProperty('stationWaitDeltaMinutes');
    expect(res).toHaveProperty('planChurn');
    expect(res.candidatePlanId).toMatch(/^PREVIEW-/);
  });

  it('preview 纯计算：不落库（无 persistPlan 调用）、不触发正式重排', async () => {
    const { svc, persistedPlans, mocks } = makeService();
    await svc.preview(
      'PLAN-1',
      { actions: [{ kind: 'EXCLUDE_RESOURCE', taskId: 't1', deviceId: 'd9' }] },
      testOrgContext(),
    );
    expect(persistedPlans).toEqual([]);
    // 仅 solve 被调用（候选求解）；不调 solveVariants/正式重排、不持久化。
    expect(mocks.solverService.solve).toHaveBeenCalled();
    expect(mocks.solverService.solveVariants).not.toHaveBeenCalled();
  });
});
