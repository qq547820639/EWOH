/* §5.4 RouteCost STRICT / DEGRADED / ADVISORY 三级策略测试（scheduler-prod-convergence Task 2）。
 *
 * 覆盖：
 *   - STRICT：travel-cost 层 euclidean fallback RouteCost feasible=false；
 *     candidate 层拒绝（rejectReasons 含 route_infeasible）。
 *   - DEGRADED（缺省/显式）：降级候选可行、带 fallbackReason/dataQuality（现状回归）。
 *   - ADVISORY：成本层降级仍可行（参考语义），dispatch 层 fail-closed——
 *     safety-critical + euclidean_fallback → SAFETY_CRITICAL_DEGRADED_ROUTE；
 *     同模式非 safety-critical / route_graph 路径正常 dispatch；
 *     DEGRADED（缺省）模式 safety-critical + euclidean_fallback 正常 dispatch（回归）。
 */
/// <reference types="jest" />
import { TravelCostService } from '../travel-cost.service';
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import { makeDispatchCoordinator } from './dispatch-test-harness';
import { defaultPolicy, defaultConfig } from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';

/** route graph 不可达的显式降级响应（routing mock 返回）。 */
const EUCLIDEAN_FALLBACK_ROUTE = {
  routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
  source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
  calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'no_route_edge', dataQuality: 'FRESH',
};

/** dispatch 层 mock 返回的 euclidean 降级 RouteCost。 */
const EUCLIDEAN_FALLBACK_COST = {
  routeId: null, distanceMeters: 100, etaSeconds: 100, riskLevel: null,
  feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
  graphVersion: null, calculatedAt: new Date().toISOString(),
  fallbackReason: 'no_route_edge', dataQuality: 'UNKNOWN',
};

describe('§5.4 TravelCostService 模式感知（estimate 层）', () => {
  function makeSvc(mode: 'STRICT' | 'DEGRADED' | 'ADVISORY' | undefined) {
    const routing = {
      calculateRouteBetween: jest.fn().mockResolvedValue(EUCLIDEAN_FALLBACK_ROUTE),
      calculateRoute: jest.fn(),
    };
    const policy = {
      getConfig: jest.fn().mockResolvedValue(
        mode ? { walkingSpeedMps: 1, routeCostMode: mode } : { walkingSpeedMps: 1 },
      ),
    };
    const svc = new TravelCostService({} as never, routing as never, policy as never);
    return { svc, routing, policy };
  }

  it('STRICT：euclidean fallback RouteCost feasible=false（source/fallbackReason/dataQuality 不变）', async () => {
    const { svc } = makeSvc('STRICT');
    const cost = await svc.estimate('p1', 't1', { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(cost.source).toBe('euclidean_fallback');
    expect(cost.fallbackReason).toBe('no_route_edge');
    expect(cost.dataQuality).toBe('FRESH');
    expect(cost.feasible).toBe(false);
  });

  it('DEGRADED（显式）与缺省未配置：euclidean fallback 候选可行（现状回归）', async () => {
    for (const mode of ['DEGRADED', undefined] as const) {
      const { svc } = makeSvc(mode);
      const cost = await svc.estimate('p1', 't1', { x: 0, y: 0 }, { x: 10, y: 0 });
      expect(cost.source).toBe('euclidean_fallback');
      expect(cost.fallbackReason).toBe('no_route_edge');
      expect(cost.feasible).toBe(true);
    }
  });

  it('ADVISORY：euclidean 降级仅参考，成本层仍可行（阻断在 dispatch 层）', async () => {
    const { svc } = makeSvc('ADVISORY');
    const cost = await svc.estimate('p1', 't1', { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(cost.source).toBe('euclidean_fallback');
    expect(cost.feasible).toBe(true);
  });
});

describe('§5.4 CandidateEngineService STRICT 拒绝降级候选', () => {
  function makeSnapshot(): WorldStateSnapshot {
    return {
      snapshotVersion: 'WS-ROUTE-MODE-0001',
      ts: new Date().toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: ['cert-a'], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      tasks: [
        {
          id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
          assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
          planStart: null, planEnd: null, progress: 0, predecessorIds: [],
          requiredSkills: ['work'], requiredCertifications: [],
        },
      ],
      devices: [
        { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
      ],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
      ],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    };
  }

  /** 构造真实 TravelCostService（mode 感知）+ CandidateEngineService 集成。 */
  function makeEngine(mode: 'STRICT' | 'DEGRADED' | undefined) {
    const worldState = {
      getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
      buildSnapshot: jest.fn(),
    };
    const resourceProjection = {
      projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
    };
    const routing = {
      calculateRouteBetween: jest.fn().mockResolvedValue(EUCLIDEAN_FALLBACK_ROUTE),
      calculateRoute: jest.fn(),
    };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(
        mode ? { ...defaultConfig(), routeCostMode: mode } : defaultConfig(),
      ),
    };
    const travelCost = new TravelCostService({} as never, routing as never, policy as never);
    const engine = new CandidateEngineService(
      worldState as never,
      resourceProjection as never,
      new EligibilityService(),
      travelCost as never,
      policy as never,
    );
    return { engine, routing };
  }

  it('STRICT：euclidean 降级候选在 candidate 层被拒绝（route_infeasible / eligible=false）', async () => {
    const { engine, routing } = makeEngine('STRICT');
    const res = await engine.evaluateTaskCandidates('t1');
    expect(routing.calculateRouteBetween).toHaveBeenCalled();
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('route_infeasible');
  });

  it('DEGRADED（缺省）：euclidean 降级候选保持可行（不因缺省配置拒绝）', async () => {
    const { engine } = makeEngine(undefined);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(true);
    expect(c.rejectReasons).not.toContain('route_infeasible');
  });
});

describe('§5.4 DispatchCoordinatorService ADVISORY fail-closed', () => {
  const ctx = { userId: 'u1', primaryOrgId: 'org1' };

  it('ADVISORY + safety-critical + euclidean_fallback → SAFETY_CRITICAL_DEGRADED_ROUTE', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [{ planId: 'PLAN-ADV-1', status: 'approved', snapshotVersion: 'WS-ADV-1' }],
      assignments: [
        { assignmentId: 'ASG-ADV-1', planId: 'PLAN-ADV-1', taskId: 'T-SAFE', personId: 'p1', status: 'approved' },
      ],
      tasks: [{ id: 'T-SAFE', status: 'pending_dispatch', safetyCritical: true }],
    });
    (mocks.policyService.getConfig as jest.Mock).mockResolvedValue({
      defaultTaskDurationMs: 1_800_000, routeCostMode: 'ADVISORY',
    });
    (mocks.travelCostService.estimate as jest.Mock).mockResolvedValue(EUCLIDEAN_FALLBACK_COST);

    await expect(svc.dispatch('PLAN-ADV-1', ctx)).rejects.toThrow(
      'SAFETY_CRITICAL_DEGRADED_ROUTE',
    );
  });

  it('ADVISORY + safety-critical + route_graph → 正常派工（放行）', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [{ planId: 'PLAN-ADV-2', status: 'approved', snapshotVersion: 'WS-ADV-2', orgId: 'org1' }],
      assignments: [
        { assignmentId: 'ASG-ADV-2', planId: 'PLAN-ADV-2', taskId: 'T-SAFE', personId: 'p1', status: 'approved', version: 1, orgId: 'org1' },
      ],
      tasks: [{ id: 'T-SAFE', status: 'pending_dispatch', safetyCritical: true }],
    });
    (mocks.policyService.getConfig as jest.Mock).mockResolvedValue({
      defaultTaskDurationMs: 1_800_000, routeCostMode: 'ADVISORY',
    });
    // harness 默认 estimate mock 返回 route_graph（不阻断）。
    const res = await svc.dispatch('PLAN-ADV-2', ctx);
    expect(res.planId).toBe('PLAN-ADV-2');
    expect(res.dispatchedAssignments).toBe(1);
  });

  it('ADVISORY + 非 safety-critical + euclidean_fallback → 正常派工（放行）', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [{ planId: 'PLAN-ADV-3', status: 'approved', snapshotVersion: 'WS-ADV-3', orgId: 'org1' }],
      assignments: [
        { assignmentId: 'ASG-ADV-3', planId: 'PLAN-ADV-3', taskId: 'T-NORM', personId: 'p1', status: 'approved', version: 1, orgId: 'org1' },
      ],
      tasks: [{ id: 'T-NORM', status: 'pending_dispatch', safetyCritical: false }],
    });
    (mocks.policyService.getConfig as jest.Mock).mockResolvedValue({
      defaultTaskDurationMs: 1_800_000, routeCostMode: 'ADVISORY',
    });
    (mocks.travelCostService.estimate as jest.Mock).mockResolvedValue(EUCLIDEAN_FALLBACK_COST);
    const res = await svc.dispatch('PLAN-ADV-3', ctx);
    expect(res.planId).toBe('PLAN-ADV-3');
    expect(res.dispatchedAssignments).toBe(1);
  });

  it('DEGRADED（缺省 routeCostMode）+ safety-critical + euclidean_fallback → 正常派工（回归）', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [{ planId: 'PLAN-DEG-1', status: 'approved', snapshotVersion: 'WS-DEG-1', orgId: 'org1' }],
      assignments: [
        { assignmentId: 'ASG-DEG-1', planId: 'PLAN-DEG-1', taskId: 'T-SAFE', personId: 'p1', status: 'approved', version: 1, orgId: 'org1' },
      ],
      tasks: [{ id: 'T-SAFE', status: 'pending_dispatch', safetyCritical: true }],
    });
    // 缺省：policyService.getConfig 无 routeCostMode → 非 ADVISORY → 不阻断。
    (mocks.travelCostService.estimate as jest.Mock).mockResolvedValue(EUCLIDEAN_FALLBACK_COST);
    const res = await svc.dispatch('PLAN-DEG-1', ctx);
    expect(res.planId).toBe('PLAN-DEG-1');
    expect(res.dispatchedAssignments).toBe(1);
  });
});
