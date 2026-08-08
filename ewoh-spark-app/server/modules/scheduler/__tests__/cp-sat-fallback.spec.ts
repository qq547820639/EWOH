import type { SolverResponse } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';

/** 构造一个可解析为给定 SolverResponse 的 fetch 替身。 */
function stubFetchReturning(response: SolverResponse): typeof globalThis.fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: {},
    json: async () => response,
  }) as unknown as typeof globalThis.fetch;
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
      stationId: null,
      startMs: 1_700_000_000_000,
      endMs: 1_700_018_000_000,
      reasons: ['cpsat-selected'],
      rejectedAlternatives: [{ personId: 'p2', reason: 'worse_score' }],
    },
  ],
};

describe('CP-SAT 求解器回退（fallback）', () => {
  const snapshot = buildSnapshot({
    persons: [seedPerson({ id: 'p1' })],
    tasks: [seedTask({ id: 't1' })],
    devices: [seedDevice({ id: 'd1' })],
  });
  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  it('Worker 不可达 → 回退启发式：solverStatus=UNAVAILABLE，solverVersion 为启发式（非 cpsat）', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
      fetch: jest
        .fn()
        .mockRejectedValue(new Error('network disabled in unit test')) as unknown as typeof globalThis.fetch,
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('UNAVAILABLE');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
    expect(plan.solverVersion).toBe('heuristic-v2');
    // 回退结果仍是有效方案：无硬违例、含 assignment。
    expect(plan.violations).toEqual([]);
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(plan.assignments[0].taskId).toBe('t1');
  });

  it('Worker 可达但返回 UNAVAILABLE → solverStatus=FALLBACK', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetchReturning({
        ...OPTIMAL_RESPONSE,
        solverStatus: 'UNAVAILABLE',
        assignments: [],
      }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it('Worker 可达但超时（TIMEOUT）→ solverStatus=FALLBACK', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetchReturning({
        ...OPTIMAL_RESPONSE,
        solverStatus: 'TIMEOUT',
        assignments: [],
      }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
  });

  it('回退结果是一个合法 SchedulingPlanV2（hardViolations 为空、assignments 存在）', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
      fetch: jest
        .fn()
        .mockRejectedValue(new Error('network disabled in unit test')) as unknown as typeof globalThis.fetch,
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.planId).toBe('P');
    expect(plan.assignments).toBeInstanceOf(Array);
    expect(plan.metrics).toBeDefined();
    expect(plan.violations).toBeInstanceOf(Array);
    expect(plan.createdAt).toBeDefined();
  });

  it('（可选）Worker 返回 OPTIMAL → 采用 CP-SAT 版本/状态与 assignment', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetchReturning(OPTIMAL_RESPONSE),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(plan.objective).toBe(5);
    expect(plan.objectiveBreakdown).toEqual({ lateness: 1, travel: 4 });
    expect(plan.violations).toEqual([]);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].taskId).toBe('t1');
    expect(plan.assignments[0].personId).toBe('p1');
    expect(plan.assignments[0].decisionTrace?.selectedReason).toEqual([
      'cpsat-selected',
    ]);
  });

  it('CP-SAT 路径 DecisionTrace 使用真实 priority（P0-SCHED-002：禁止 0/[] 占位）', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetchReturning(OPTIMAL_RESPONSE),
    });
    const plan = await solver.solve(snapshot, [], opts);
    const dt = plan.assignments[0].decisionTrace;

    expect(dt).toBeDefined();
    // priority 必须来自真实 PriorityEngine（score 为 number 且非占位 0/空）
    expect(dt?.priority.score).not.toBeNull();
    expect(typeof dt?.priority.score).toBe('number');
    expect(dt?.priority.level).toBeDefined();
    expect((dt?.priority.factors ?? []).length).toBeGreaterThan(0);
    // 候选必须来自真实 worker 返回（被拒候选），不得为空数组冒充"无候选"
    expect((dt?.candidates ?? []).length).toBeGreaterThan(0);
    expect((dt?.rejectedAlternatives ?? []).length).toBeGreaterThan(0);
  });
});