/* Task A / P0：SolverService 激活阶梯唯一事实源（OFF/SHADOW/CANARY/PRODUCTION）。
 *
 * 覆盖：
 * 1. OFF（缺省）：CP-SAT 不参与任何路径（fetch 绝不调用），仅 heuristic 生产；
 * 2. SHADOW：heuristic 生产 + CP-SAT 双跑（shadow 标记 isShadow），绝不返回 CP-SAT 为生产方案；
 *    不可达时生产方案保持 heuristic（不抛）；
 * 3. CANARY：fraction=1.0 采样命中 → CP-SAT 生产路径；fraction=0 → heuristic-only；
 *    org allowlist 命中即采样；worker 不可达 → heuristic 回退 + canary 归 0 + outbox rollback 事件；
 * 4. PRODUCTION：生产门禁未开（EWOH_SOLVER_PRODUCTION_ENABLED!==1）→ fail-closed heuristic
 *    + fallbackReason=production_not_gated；门禁已开 → CP-SAT 首选手（OPTIMAL 被采用）；
 * 5. env 覆盖：EWOH_SOLVER_ACTIVATION 优先于配置；非法值 → warn + 回退 OFF。
 * 每个方案记录 baselineDelta.solverActivation（state/canaryFraction/orgAllowlisted）审计。
 */
/// <reference types="jest" />
import type { SolverResponse } from '@shared/api.interface';
import { ShadowEvaluatorService } from '../prediction/shadow-evaluator.service';
import { MILP_SOLVER_VERSION } from '../milp-scheduling-solver';
import { RULE_BASED_SOLVER_VERSION } from '../rule-based-scheduling-solver';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
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

function clearActivationEnv(): void {
  delete process.env.EWOH_SOLVER_ACTIVATION;
  delete process.env.EWOH_SOLVER_PRODUCTION_ENABLED;
}

/** 读取 plan.baselineDelta.solverActivation 审计字段。 */
function activationOf(plan: import('@shared/api.interface').SchedulingPlanV2) {
  return (plan.baselineDelta?.solverActivation ?? {}) as {
    state: string;
    canaryFraction: number;
    orgAllowlisted: boolean;
  };
}

describe('SolverService 激活阶梯（Task A / P0）', () => {
  const snapshot = buildSnapshot({
    persons: [seedPerson({ id: 'p1', skills: ['work'] })],
    tasks: [seedTask({ id: 't1', taskType: 'work' })],
    devices: [seedDevice({ id: 'd1' })],
  });
  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  beforeEach(clearActivationEnv);
  afterEach(clearActivationEnv);

  it('OFF（缺省）：CP-SAT 不参与任何路径，仅 heuristic 生产', async () => {
    const fetch = jest.fn().mockImplementation(() => {
      throw new Error('CP-SAT must not be called in OFF activation');
    }) as unknown as typeof globalThis.fetch;
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch,
    });

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).not.toHaveBeenCalled();
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(plan.solverVersion).toBe('heuristic-v2');
    expect(activationOf(plan).state).toBe('OFF');
    expect(activationOf(plan).orgAllowlisted).toBe(false);
  });

  it('SHADOW：双跑 heuristic 生产 + CP-SAT shadow（isShadow），绝不返回 CP-SAT 为生产方案', async () => {
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver, metricsService } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'SHADOW' } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    // CP-SAT 被双跑（fetch 恰一次；生产方案始终 heuristic）。
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(plan.solverVersion).toBe('heuristic-v2');
    expect(plan.planId).toBe('P');
    expect(activationOf(plan).state).toBe('SHADOW');
    // shadow 运行被记录（CP-SAT 状态 OPTIMAL 进入观测，不进入生产方案）。
    expect(metricsService.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ solverStatus: 'OPTIMAL' }),
    );
  });

  it('SHADOW：CP-SAT 不可达 → 生产方案保持 heuristic（仅记录，不抛、不影响返回）', async () => {
    const fetch = jest.fn().mockRejectedValue(
      new Error('network disabled in unit test'),
    ) as unknown as typeof globalThis.fetch;
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:1', timeoutMs: 50, fetch },
      { cpSat: { activation: 'SHADOW' } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(plan.solverVersion).toBe('heuristic-v2');
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it('CANARY fraction=1.0：采样命中 → CP-SAT 为生产路径（OPTIMAL 被采用）', async () => {
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'CANARY', canaryFraction: 1.0 } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(activationOf(plan).state).toBe('CANARY');
    expect(activationOf(plan).canaryFraction).toBe(1);
    expect(activationOf(plan).orgAllowlisted).toBe(true);
  });

  it('CANARY fraction=0：不采样 → 仅 heuristic（CP-SAT 不调用）', async () => {
    const fetch = jest.fn().mockImplementation(() => {
      throw new Error('CP-SAT must not be called when canary fraction is 0');
    }) as unknown as typeof globalThis.fetch;
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'CANARY', canaryFraction: 0 } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).not.toHaveBeenCalled();
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(activationOf(plan).orgAllowlisted).toBe(false);
  });

  it('CANARY：org allowlist 命中即采样（fraction=0 也采样）', async () => {
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      {
        cpSat: {
          activation: 'CANARY',
          canaryFraction: 0,
          orgAllowlist: ['org-A'],
        },
      },
    );

    const plan = await solver.solve(snapshot, [], { ...opts, orgId: 'org-A' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(activationOf(plan).orgAllowlisted).toBe(true);
  });

  it('CANARY worker 不可达 → 采纳 heuristic 回退 + canary 归 0 + outbox rollback 事件', async () => {
    const fetch = jest.fn().mockRejectedValue(
      new Error('network disabled in unit test'),
    ) as unknown as typeof globalThis.fetch;
    const evaluator = new ShadowEvaluatorService();
    evaluator.setCanaryFraction(0.5);
    expect(evaluator.getCanaryFraction()).toBe(0.5);
    const outbox = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'evt',
        eventType: 'policy.shadow.canary.rollback',
        entityId: 'P',
        payload: {},
        status: 'pending',
        sequence: 1,
        createdAt: new Date().toISOString(),
      }),
    };
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:1', timeoutMs: 50, fetch },
      { cpSat: { activation: 'CANARY', canaryFraction: 1.0 } },
      { shadowEvaluatorService: evaluator, outboxService: outbox as never },
    );

    const plan = await solver.solve(snapshot, [], opts);

    // 回退方案如实标记 UNAVAILABLE（不冒充 CP-SAT 成功），solverVersion 为启发式。
    expect(plan.solverStatus).toBe('UNAVAILABLE');
    expect(plan.solverVersion).toBe('heuristic-v2');
    expect(plan.assignments.length).toBeGreaterThan(0);
    // canary 自动归 0 + outbox 审计事件。
    expect(evaluator.getCanaryFraction()).toBe(0);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'policy.shadow.canary.rollback',
      'P',
      expect.objectContaining({ canaryRolledBack: true }),
      null,
      undefined,
      expect.objectContaining({ entityType: 'policy' }),
    );
  });

  it('PRODUCTION 但生产门禁未开（EWOH_SOLVER_PRODUCTION_ENABLED!==1）→ fail-closed heuristic + production_not_gated', async () => {
    const fetch = jest.fn().mockImplementation(() => {
      throw new Error('CP-SAT must not be called when production gate is closed');
    }) as unknown as typeof globalThis.fetch;
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'PRODUCTION' } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).not.toHaveBeenCalled(); // fail-closed：CP-SAT 从未尝试
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(plan.solverVersion).toBe('heuristic-v2');
    expect(plan.fallbackReason).toBe('production_not_gated');
    expect(activationOf(plan).state).toBe('PRODUCTION');
  });

  it('PRODUCTION + 生产门禁已开 → CP-SAT 首选手（OPTIMAL 被采用，既有行为）', async () => {
    process.env.EWOH_SOLVER_PRODUCTION_ENABLED = '1';
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'PRODUCTION' } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(activationOf(plan).state).toBe('PRODUCTION');
  });

  it('env 覆盖：EWOH_SOLVER_ACTIVATION=PRODUCTION 覆盖配置缺省 OFF', async () => {
    process.env.EWOH_SOLVER_ACTIVATION = 'PRODUCTION';
    process.env.EWOH_SOLVER_PRODUCTION_ENABLED = '1';
    const fetch = stubFetchReturning(OPTIMAL_RESPONSE);
    // 配置缺省（无 cpSat）→ OFF；env 优先提升到 PRODUCTION。
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch,
    });

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plan.solverVersion).toBe('cpsat-v1');
  });

  it('env 非法值 → warn + 回退 OFF（仅 heuristic，配置 CANARY 也被 env 覆盖为 OFF）', async () => {
    process.env.EWOH_SOLVER_ACTIVATION = 'BOGUS';
    const fetch = jest.fn().mockImplementation(() => {
      throw new Error('CP-SAT must not be called with invalid activation env');
    }) as unknown as typeof globalThis.fetch;
    const { solver } = makeSolver(
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      { cpSat: { activation: 'CANARY', canaryFraction: 1.0 } },
    );

    const plan = await solver.solve(snapshot, [], opts);

    expect(fetch).not.toHaveBeenCalled();
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(activationOf(plan).state).toBe('OFF');
  });

  // T10（审计批次 D）：统一回退语义——策略声明求解器基础设施性失败 → 显式
  // 记录并回退 heuristic（与 CP-SAT 采样路径同语义；solverStatus 如实标记
  // HEURISTIC 生产者，solverActivation 审计仍如实标记声明轨道）。
  it('T10 统一回退：策略声明 milp-v1 且 MILP 基础设施失败 → 显式回退 heuristic（activation 仍标 MILP）', async () => {
    const { solver } = makeSolver();
    const milpStub = {
      solve: jest.fn().mockRejectedValue(new Error('milp-v1: HiGHS WASM 加载失败')),
    };
    (solver as unknown as { milpSolver: unknown }).milpSolver = milpStub;

    const plan = await solver.solve(snapshot, [], {
      ...opts,
      policy: { ...opts.policy, solverVersion: MILP_SOLVER_VERSION },
    });

    expect(milpStub.solve).toHaveBeenCalledTimes(1);
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(activationOf(plan).state).toBe('MILP');
  });

  it('T10 统一回退：策略声明 rule-based-v1 且求解异常 → 显式回退 heuristic（activation 仍标 RULE_BASED）', async () => {
    const { solver } = makeSolver();
    const ruleStub = {
      solve: jest.fn().mockRejectedValue(new Error('rule-based-v1: 内部异常')),
    };
    (solver as unknown as { ruleBasedSolver: unknown }).ruleBasedSolver = ruleStub;

    const plan = await solver.solve(snapshot, [], {
      ...opts,
      policy: { ...opts.policy, solverVersion: RULE_BASED_SOLVER_VERSION },
    });

    expect(ruleStub.solve).toHaveBeenCalledTimes(1);
    expect(plan.solverStatus).toBe('HEURISTIC');
    expect(activationOf(plan).state).toBe('RULE_BASED');
  });
});
