/* P0-2 / P0-3 / P0-4：CP-SAT 请求契约测试。
 *
 * 验证 Nest CpSatSchedulingSolver 发送给 worker 的请求体与 Python contract.py
 * 对齐（P0-2 核心回归：旧实现发送 skillMatchMode 但 contract.py 未声明 → worker 400
 * → CP-SAT 在生产恒回退 heuristic）：
 *   1. 请求体包含 skillMatchMode（ALL/ANY）与 effectivePriorityScore；
 *   2. 请求体包含 mustFinishByMs（P0-3 硬截止）与 dueMs（软 due）；
 *   3. 请求体包含 candidateCosts（P0-4 权威 RouteCost 矩阵，来自 buildEligibilityMatrix）；
 *   4. 响应（OPTIMAL）能被正确解析为 SchedulingPlanV2。
 */
/// <reference types="jest" />
import type { SolverResponse } from '@shared/api.interface';
import { CpSatSchedulingSolver } from '../cp-sat-scheduling-solver';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { EligibilityService } from '../eligibility.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  defaultConfig,
} from './scheduler-test-helpers';

function stubFetchReturning(response: SolverResponse): typeof globalThis.fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: {},
    json: async () => response,
  }) as unknown as typeof globalThis.fetch;
}

/** 构造带 travelCostService（buildEligibilityMatrix + buildMatrix）的 CpSatSchedulingSolver。 */
function makeCpSatSolver(config: {
  fetch: typeof globalThis.fetch;
  matrixCandidates?: Array<Record<string, unknown>>;
}) {
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-TEST' }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'ROUTE-TEST',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
    }),
  };
  const heuristic = new HeuristicSchedulingSolver(
    policy as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
  );
  // P0-4：矩阵层提供权威候选成本（含 feasible/geometry 等 RouteCost 字段）。
  const travelCostService = {
    buildEligibilityMatrix: jest.fn().mockResolvedValue(
      new Map([['t1', { personIds: ['p1'], deviceIds: ['d1'] }]]),
    ),
    buildMatrix: jest.fn().mockResolvedValue({
      matrixId: 'RCM-TEST',
      snapshotVersion: 'WS-TEST-0001',
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
      taskId: 't1',
      candidates:
        config.matrixCandidates ??
        [
          {
            personId: 'p1',
            deviceId: 'd1',
            stationId: 'S1',
            etaSeconds: 60,
            distanceMeters: 120,
            congestion: 1,
            blocked: false,
            forbiddenZone: false,
            risk: 1,
            energy: 0,
            routeCostMode: 'route_graph',
            fallbackReason: null,
            dataQuality: 'FRESH',
            feasible: true,
            geometry: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        ],
      generatedAt: new Date().toISOString(),
    }),
  };
  const solver = new CpSatSchedulingSolver(
    heuristic,
    { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch: config.fetch },
    travelCostService as never,
    undefined,
  );
  return { solver, travelCostService };
}

const OPTIMAL_RESPONSE: SolverResponse = {
  solverVersion: 'cpsat-v1',
  solverStatus: 'OPTIMAL',
  solveDurationMs: 12,
  objective: 5,
  objectiveBreakdown: { lateness: 1, travel: 4 },
  hardViolations: [],
  optimalityGap: 0,
  unassignedTaskIds: [],
  assignments: [
    {
      taskId: 't1',
      personId: 'p1',
      deviceId: 'd1',
      stationId: 'S1',
      startMs: 1_700_000_000_000,
      endMs: 1_700_018_000_000,
      reasons: ['cpsat-selected'],
      rejectedAlternatives: [],
    },
  ],
};

describe('P0-2: CP-SAT 请求契约（skillMatchMode / effectivePriorityScore）', () => {
  const snapshot = buildSnapshot({
    persons: [seedPerson({ id: 'p1', skills: ['a', 'b'] })],
    tasks: [
      seedTask({
        id: 't1',
        requiredSkills: ['a', 'b'],
      }),
    ],
    devices: [seedDevice({ id: 'd1' })],
    stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
  });
  // seedTask 不支持 skillMatchMode，直接扩展。
  const snapWithMode: typeof snapshot = {
    ...snapshot,
    tasks: [
      {
        ...snapshot.tasks[0],
        stationId: 'S1',
        skillMatchMode: 'ANY' as const,
        latestFinishMs: 1_700_360_000_000,
        dueAtMs: 1_700_300_000_000,
      },
    ],
  };
  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  it('请求体包含 skillMatchMode=ANY / effectivePriorityScore / dueMs / mustFinishByMs', async () => {
    const fetch = jest.fn() as unknown as typeof globalThis.fetch;
    const resolveFetch = stubFetchReturning(OPTIMAL_RESPONSE);
    (fetch as unknown as jest.Mock).mockImplementation(resolveFetch);
    const { solver } = makeCpSatSolver({ fetch });

    await solver.solve(snapWithMode, [], opts);

    const call = (fetch as unknown as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(body.tasks).toHaveLength(1);
    const t = body.tasks[0];
    // P0-2：契约字段必须发送（旧实现发送但 contract.py 未声明 → worker 400）。
    expect(t.skillMatchMode).toBe('ANY');
    expect(typeof t.effectivePriorityScore).toBe('number');
    // P0-3：due 软 / mustFinishBy 硬分离。
    expect(t.dueMs).toBe(1_700_300_000_000);
    expect(t.mustFinishByMs).toBe(1_700_360_000_000);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, -1, 101, 0, 15, 100])(
    'preserves battery truth for %p in the worker request',
    async (batteryPct) => {
      const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
      const { solver } = makeCpSatSolver({ fetch });
      const device = Object.assign({}, snapshot.devices[0], { batteryPct });
      await solver.solve({ ...snapWithMode, devices: [device] }, [], opts);
      const request = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      const expected = typeof batteryPct === 'number' && Number.isFinite(batteryPct)
        && batteryPct >= 0 && batteryPct <= 100 ? batteryPct : null;
      expect(request.devices[0].batteryPct).toBe(expected);
      const blocked = expected == null || expected < defaultConfig().minBatteryPct;
      expect(request.safetyBlockedDeviceIds.includes('d1')).toBe(blocked);
      expect(request.tasks[0].eligibleDeviceIds.includes('d1')).toBe(!blocked);
    },
  );

  it.each([null, NaN, Infinity, -1, 101, 0])(
    'rejects worker assignments that bypass battery safety for %p', async (batteryPct) => {
      const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
      const { solver } = makeCpSatSolver({ fetch });
      const invalid = {
        ...snapWithMode,
        devices: [{ ...snapshot.devices[0], batteryPct, capabilities: ['lift'] }],
        tasks: [{ ...snapWithMode.tasks[0], requiredDeviceCapabilities: ['lift'] }],
      };
      const plan = await solver.solve(invalid, [], opts);
      expect(plan.solverStatus).toBe('FALLBACK');
      expect(plan.fallbackReason).toBe('cpsat_device_battery_unavailable_or_low');
      expect(plan.assignments).toEqual([]);
    },
  );

  it('请求体包含 candidateCosts（P0-4 权威 RouteCost 矩阵透传）', async () => {
    const fetch = jest.fn() as unknown as typeof globalThis.fetch;
    (fetch as unknown as jest.Mock).mockImplementation(
      stubFetchReturning(OPTIMAL_RESPONSE),
    );
    const { solver } = makeCpSatSolver({ fetch });

    await solver.solve(snapWithMode, [], opts);

    const call = (fetch as unknown as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body) as {
      candidateCosts: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.candidateCosts)).toBe(true);
    expect(body.candidateCosts.length).toBeGreaterThan(0);
    const cc = body.candidateCosts[0];
    expect(cc.taskId).toBe('t1');
    expect(cc.personId).toBe('p1');
    expect(cc.stationId).toBe('S1');
    expect(cc.distanceMeters).toBe(120);
    expect(cc.etaSeconds).toBe(60);
    expect(cc.dataQuality).toBe('FRESH');
  });

  it('OPTIMAL 响应可正确解析为 SchedulingPlanV2（含 geometry 恢复）', async () => {
    const fetch = jest.fn() as unknown as typeof globalThis.fetch;
    (fetch as unknown as jest.Mock).mockImplementation(
      stubFetchReturning(OPTIMAL_RESPONSE),
    );
    const { solver } = makeCpSatSolver({ fetch });

    const plan = await solver.solve(snapWithMode, [], opts);

    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].personId).toBe('p1');
    // P4-GEOM：assignment 恢复矩阵几何。
    expect(plan.assignments[0].routeGeometry).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it.each([
    ['unknown task', { taskId: 'other', personId: 'p1', deviceId: 'd1', stationId: 'S1' }],
    ['unknown person', { taskId: 't1', personId: 'ghost', deviceId: 'd1', stationId: 'S1' }],
    ['unknown device', { taskId: 't1', personId: 'p1', deviceId: 'ghost', stationId: 'S1' }],
    ['unknown station', { taskId: 't1', personId: 'p1', deviceId: 'd1', stationId: 'ghost' }],
    ['ineligible person', { taskId: 't1', personId: 'p2', deviceId: 'd1', stationId: 'S1' }],
  ])('rejects semantic bypass: %s', async (_label, assignmentOverride) => {
    const fetch = stubFetchReturning({
      ...OPTIMAL_RESPONSE,
      assignments: [{ ...OPTIMAL_RESPONSE.assignments[0], ...assignmentOverride }],
    });
    const { solver } = makeCpSatSolver({ fetch });
    const plan = await solver.solve(snapWithMode, [], opts);
    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.fallbackReason).toBe('cpsat_response_semantic_validation_failed');
    expect(plan.assignments).toHaveLength(0);
  });

  it('rejects duplicated task assignments from the worker', async () => {
    const assignment = OPTIMAL_RESPONSE.assignments[0];
    const fetch = stubFetchReturning({
      ...OPTIMAL_RESPONSE,
      assignments: [assignment, { ...assignment, personId: 'p2', deviceId: null }],
    });
    const { solver } = makeCpSatSolver({ fetch });
    const plan = await solver.solve(snapWithMode, [], opts);
    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.fallbackReason).toBe('cpsat_response_semantic_validation_failed');
  });

  it('rejects assignments that exceed station capacity', async () => {
    const fetch = stubFetchReturning({
      ...OPTIMAL_RESPONSE,
      assignments: [
        OPTIMAL_RESPONSE.assignments[0],
        { ...OPTIMAL_RESPONSE.assignments[0], personId: 'p2', deviceId: null },
      ],
    });
    const { solver } = makeCpSatSolver({ fetch });
    const plan = await solver.solve(snapWithMode, [], opts);
    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.fallbackReason).toBe('cpsat_response_semantic_validation_failed');
  });

  it('rejects a worker assignment for a safety-blocked person', async () => {
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver } = makeCpSatSolver({ fetch });
    const blocked = { ...snapWithMode, safetyBlockedPersonIds: ['p1'] };
    const plan = await solver.solve(blocked, [], opts);
    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.fallbackReason).toBe('cpsat_response_semantic_validation_failed');
  });

  it('缺省 skillMatchMode → ALL（向后兼容）', async () => {
    const fetch = jest.fn() as unknown as typeof globalThis.fetch;
    (fetch as unknown as jest.Mock).mockImplementation(
      stubFetchReturning(OPTIMAL_RESPONSE),
    );
    const { solver } = makeCpSatSolver({ fetch });
    const snapAll: typeof snapshot = {
      ...snapshot,
      tasks: [
        {
          ...snapshot.tasks[0],
          stationId: 'S1',
          skillMatchMode: undefined,
        },
      ],
    };
    await solver.solve(snapAll, [], opts);
    const call = (fetch as unknown as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(body.tasks[0].skillMatchMode).toBe('ALL');
  });
});
