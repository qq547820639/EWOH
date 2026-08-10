/* Task 6 / P1：CP-SAT SHADOW 双跑 + CANARY 分歧回滚测试。
 *
 * 覆盖：
 * 1. shadowCompare 关闭（缺省）→ 仅生产方案（heuristic 单跑），不调用 CP-SAT（零行为变化）；
 * 2. shadowCompare 开启 + mock cpSat → 双跑：生产方案=heuristic，shadow 结果 isShadow
 *    （status=shadow，绝不批准/派工），comparison 摘要齐全；
 * 3. 硬约束分歧（heuristic/CP-SAT 违例集合不一致）→ canary 自动回滚至 0 + 审计事件；
 *    无分歧 → canary 保持不变。
 */
/// <reference types="jest" />
import type { SchedulingPolicyConfig, SolverResponse } from '@shared/api.interface';
import { SolverService } from '../solver.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { EligibilityService } from '../eligibility.service';
import { ShadowPolicyService } from '../shadow-policy.service';
import { ShadowEvaluatorService } from '../prediction/shadow-evaluator.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
  baseSolveOpts,
} from './scheduler-test-helpers';

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
      stationId: null,
      startMs: 1_700_000_000_000,
      endMs: 1_700_018_000_000,
      reasons: ['cpsat-selected'],
      rejectedAlternatives: [],
    },
  ],
};

function stubFetchReturning(response: SolverResponse): typeof globalThis.fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: {},
    headers: { get: () => null },
    json: async () => response,
  }) as unknown as typeof globalThis.fetch;
}

/** 构造 SolverService（同 makeSolver 的 mock 风格；configOverride 可注入 cpSat.shadowCompare）。 */
function makeShadowSolver(
  cpSatConfig: import('../cp-sat-scheduling-solver').CpSatSolverConfig,
  configOverride?: Partial<SchedulingPolicyConfig>,
) {
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-TEST' }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue({ ...defaultConfig(), ...configOverride }),
    resolveProfiles: SchedulingPolicyService.prototype.resolveProfiles,
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
  const metricsService = {
    recordRun: jest.fn(),
    recordFallback: jest.fn(),
    recordSolverTimeout: jest.fn(),
    recordPlanChurn: jest.fn(),
    recordPartialReplanAffected: jest.fn(),
    recordCandidateCount: jest.fn(),
    recordHardReject: jest.fn(),
  } as never;
  const solver = new SolverService(
    policy as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
    cpSatConfig,
    metricsService,
    undefined as never,
  );
  return { solver, policy, metricsService, routeCostProvider };
}

function snapshot() {
  return buildSnapshot({
    persons: [seedPerson({ id: 'p1', skills: ['work'] })],
    tasks: [seedTask({ id: 't1', taskType: 'work' })],
    devices: [seedDevice({ id: 'd1' })],
  });
}

function planWithViolations(
  planId: string,
  violations: Array<Record<string, unknown>>,
): import('@shared/api.interface').SchedulingPlanV2 {
  return {
    planId,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-TEST-0001',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: {
      lateMinutes: 0,
      walkingMeters: 0,
      stationWaitMinutes: 0,
      maxWorkload: 0,
      changeCost: 0,
    },
    baselineDelta: {},
    violations,
    createdAt: new Date().toISOString(),
  };
}

describe('Task 6 / P1: CP-SAT SHADOW compare（schedulingPolicyConfig.cpSat?.shadowCompare）', () => {
  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  it('shadowCompare 关闭（缺省）→ 仅 heuristic 生产方案，不调用 CP-SAT（零行为变化）', async () => {
    const fetch = jest.fn().mockImplementation(() => {
      throw new Error('CP-SAT must not be called when shadowCompare is off');
    }) as unknown as typeof globalThis.fetch;
    const { solver } = makeShadowSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch,
    });

    const result = await solver.solveShadowCompare(snapshot(), [], opts);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.shadowPlan).toBeNull();
    expect(result.comparison).toBeNull();
    // 生产方案 = heuristic（与现状一致）。
    expect(result.productionPlan.solverStatus).toBe('HEURISTIC');
    expect(result.productionPlan.solverVersion).toBe('heuristic-v2');
    expect(result.productionPlan.assignments.length).toBeGreaterThan(0);
  });

  it('shadowCompare 开启 + mock cpSat → 双跑：生产=heuristic，shadow=isShadow，comparison 齐全', async () => {
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver } = makeShadowSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { shadowCompare: true } },
    );

    const result = await solver.solveShadowCompare(snapshot(), [], opts);

    // CP-SAT 被调用一次，且携带 X-Request-ID 关联头。
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = (fetch as unknown as jest.Mock).mock.calls[0];
    expect(call[1].headers['X-Request-ID']).toMatch(/^req-/);

    // 生产方案 = heuristic（绝不返回 CP-SAT 作为生产方案）。
    expect(result.productionPlan.solverStatus).toBe('HEURISTIC');
    expect(result.productionPlan.solverVersion).toBe('heuristic-v2');

    // shadow 结果标记 isShadow（status=shadow → PlanService ShadowPlanGuard 拒绝批准/派工）。
    expect(result.shadowPlan).not.toBeNull();
    expect(result.shadowPlan!.status).toBe('shadow');
    expect(result.shadowPlan!.solverVersion).toBe('cpsat-v1');
    expect(result.shadowPlan!.solverStatus).toBe('OPTIMAL');
    expect(
      (result.shadowPlan!.baselineDelta?.shadow as Record<string, unknown> | undefined)
        ?.isShadow,
    ).toBe(true);

    // comparison 摘要（feasibility/objective/violations/runtime/solverStatus）。
    expect(result.comparison).not.toBeNull();
    expect(result.comparison!.productionSolverStatus).toBe('HEURISTIC');
    expect(result.comparison!.shadowSolverStatus).toBe('OPTIMAL');
    expect(result.comparison!.feasibility.production).toBe(true);
    expect(result.comparison!.feasibility.shadow).toBe(true);
    expect(result.comparison!.objective.shadow).toBe(5);
    expect(result.comparison!.violations).toEqual({
      production: 0,
      shadow: 0,
      diverged: false,
    });
    expect(result.comparison!.runtimeMs.shadow).toBe(12);
    expect(result.comparison!.solverVersion.shadow).toBe('cpsat-v1');
  });

  it('shadowCompare 开启 + CP-SAT worker 不可达 → shadow 如实标记 FALLBACK 结果（不冒充 OPTIMAL）', async () => {
    const fetch = jest.fn().mockRejectedValue(
      new Error('network disabled in unit test'),
    ) as unknown as typeof globalThis.fetch;
    const { solver } = makeShadowSolver(
      { workerUrl: 'http://127.0.0.1:1', timeoutMs: 50, fetch },
      { cpSat: { shadowCompare: true } },
    );

    const result = await solver.solveShadowCompare(snapshot(), [], opts);

    expect(result.productionPlan.solverStatus).toBe('HEURISTIC');
    expect(result.shadowPlan).not.toBeNull();
    // 不可达 → UNAVAILABLE 回退（绝不伪装 CP-SAT 成功），但仍标记 isShadow。
    expect(result.shadowPlan!.solverStatus).toBe('UNAVAILABLE');
    expect(result.shadowPlan!.status).toBe('shadow');
    expect(result.comparison!.shadowSolverStatus).toBe('UNAVAILABLE');
  });
});

describe('Task 6 / P1: CANARY 硬约束分歧自动回滚（ShadowPolicyService.handleShadowCompareDivergence）', () => {
  function makeService() {
    const outbox = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'evt',
        eventType: 'policy.shadow.canary.rollback',
        entityId: 'S',
        payload: {},
        status: 'pending',
        sequence: 1,
        createdAt: new Date().toISOString(),
      }),
    };
    const metrics = { recordPolicyEvent: jest.fn() };
    const evaluator = new ShadowEvaluatorService();
    const svc = new ShadowPolicyService(
      {} as never, // db
      {} as never, // worldStateSnapshotService
      {} as never, // solverService
      {} as never, // planService
      {} as never, // planCompareService
      metrics as never,
      outbox as never,
      evaluator,
    );
    return { svc, outbox, metrics, evaluator };
  }

  it('CP-SAT 出现 heuristic 没有的硬约束违例 → 分歧 → canary 自动回滚至 0 + 审计事件', async () => {
    const { svc, outbox, metrics, evaluator } = makeService();
    evaluator.setCanaryFraction(0.5);
    expect(evaluator.getCanaryFraction()).toBe(0.5);

    const result = await svc.handleShadowCompareDivergence(
      planWithViolations('P-1', [{ type: 'NO_DOUBLE_BOOKING' }]),
      planWithViolations('S-1', [
        { type: 'NO_DOUBLE_BOOKING' },
        { type: 'SAFETY_BLOCK' },
      ]),
    );

    expect(result.diverged).toBe(true);
    expect(result.canaryRolledBack).toBe(true);
    expect(result.reasons.join('; ')).toContain('cpsat_only_violations');
    expect(evaluator.getCanaryFraction()).toBe(0);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'policy.shadow.canary.rollback',
      'S-1',
      expect.objectContaining({ reasons: result.reasons, canaryRolledBack: true }),
      null,
      undefined,
      expect.objectContaining({ entityType: 'policy' }),
    );
    expect(metrics.recordPolicyEvent).toHaveBeenCalled();
  });

  it('heuristic 出现 CP-SAT 没有的硬约束违例 → 同样分歧 → canary 回滚', async () => {
    const { svc, evaluator } = makeService();
    evaluator.setCanaryFraction(0.2);

    const result = await svc.handleShadowCompareDivergence(
      planWithViolations('P-1', [
        { type: 'NO_DOUBLE_BOOKING' },
        { type: 'SAFETY_BLOCK' },
      ]),
      planWithViolations('S-1', [{ type: 'NO_DOUBLE_BOOKING' }]),
    );

    expect(result.diverged).toBe(true);
    expect(result.reasons.join('; ')).toContain('heuristic_only_violations');
    expect(evaluator.getCanaryFraction()).toBe(0);
  });

  it('违例集合一致（无分歧）→ canary 保持不变、无审计事件', async () => {
    const { svc, outbox, metrics, evaluator } = makeService();
    evaluator.setCanaryFraction(0.2);

    const result = await svc.handleShadowCompareDivergence(
      planWithViolations('P-1', [{ type: 'NO_DOUBLE_BOOKING' }]),
      planWithViolations('S-1', [{ type: 'NO_DOUBLE_BOOKING' }]),
    );

    expect(result.diverged).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.canaryRolledBack).toBe(false);
    expect(evaluator.getCanaryFraction()).toBe(0.2);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(metrics.recordPolicyEvent).not.toHaveBeenCalled();
  });

  it('双方均无违例 → 无分歧（最常路径：双跑都干净）', async () => {
    const { svc, evaluator } = makeService();
    evaluator.setCanaryFraction(1);

    const result = await svc.handleShadowCompareDivergence(
      planWithViolations('P-1', []),
      planWithViolations('S-1', []),
    );

    expect(result.diverged).toBe(false);
    expect(evaluator.getCanaryFraction()).toBe(1);
  });
});
