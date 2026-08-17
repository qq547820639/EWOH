/* Task 15.1 fault-injection：CP-SAT worker 畸形响应（malformed response，Nest 客户端侧）。
 *
 * 覆盖：
 *   (a) 非 JSON 垃圾 body（res.json() 解析失败）→ UNAVAILABLE + fallbackReason 提及 malformed；
 *   (b) 合法 JSON 但形状越契约（缺 solverStatus / assignments 非数组）→ FALLBACK + malformed；
 *   (c) solverStatus 未知枚举值 + assignment 条目携带越契约字段（未知枚举值）→ FALLBACK + malformed。
 * 断言（15.6：降级必须可观测，禁止 silent fallback）：
 *   - 求解器绝不 crash；
 *   - 返回启发式回退方案且 solverStatus 显式 FALLBACK/UNAVAILABLE；
 *   - fallbackReason 提及 malformed response；
 *   - recordFallback 指标被记录（注入 metrics mock 断言）；
 *   - CP-SAT 结果绝不被标记为 OPTIMAL/FEASIBLE。
 */
/// <reference types="jest" />
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';

/** 构造一个可解析/拒绝的 fetch 替身（body 恒为 truthy 以便触发 json 解析路径）。 */
function stubFetch(opts: {
  json: () => Promise<unknown>;
  status?: number;
}): typeof globalThis.fetch {
  return jest.fn().mockResolvedValue({
    ok: opts.status == null || opts.status < 400,
    status: opts.status ?? 200,
    body: {},
    json: opts.json,
  }) as unknown as typeof globalThis.fetch;
}

const snapshot = buildSnapshot({
  persons: [seedPerson({ id: 'p1' })],
  tasks: [seedTask({ id: 't1' })],
  devices: [seedDevice({ id: 'd1' })],
});

describe('CP-SAT 畸形响应（Task 15.1 fault-injection）', () => {
  beforeEach(() => {
    process.env.EWOH_SOLVER_ACTIVATION = 'PRODUCTION';
    process.env.EWOH_SOLVER_PRODUCTION_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.EWOH_SOLVER_ACTIVATION;
    delete process.env.EWOH_SOLVER_PRODUCTION_ENABLED;
  });

  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  it('(a) 非 JSON 垃圾 body → 不 crash，FALLBACK（NEST-023：worker 已应答仅 body 畸形 ≠ 不可达）+ fallbackReason 提及 malformed + 指标记录', async () => {
    const { solver, metricsService } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetch({
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    // NEST-023（2026-08-17）：worker HTTP 层已应答（reachable），仅 body 非
    // JSON——语义是"服务在但响应畸形"= FALLBACK；UNAVAILABLE 保留给真正的
    // 传输层不可达/超时。
    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
    expect(plan.fallbackReason).toMatch(/malformed/i);
    // 15.6：降级可观测 —— 指标被记录 + 显式状态字段。
    expect(metricsService.recordFallback).toHaveBeenCalled();
    expect(plan.solverStatus).not.toMatch(/OPTIMAL|FEASIBLE/);
    // 回退结果仍是有效方案。
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it('(b) 合法 JSON 但形状越契约（缺 solverStatus/assignments）→ FALLBACK + malformed + 指标记录', async () => {
    const { solver, metricsService } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetch({ json: async () => ({ foo: 'bar' }) }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
    expect(plan.fallbackReason).toMatch(/malformed/i);
    expect(metricsService.recordFallback).toHaveBeenCalled();
    expect(plan.solverStatus).not.toMatch(/OPTIMAL|FEASIBLE/);
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it('(c) solverStatus 未知枚举值 + assignment 条目越契约字段 → FALLBACK + malformed + 不 crash', async () => {
    const { solver, metricsService } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetch({
        json: async () => ({
          solverVersion: 'cpsat-v1',
          solverStatus: 'EXPLORING', // 未知枚举值（不在 SolverStatus 契约内）
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
              status: 'FLYING', // assignment 条目越契约字段（未知枚举值）
            },
          ],
        }),
      }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('FALLBACK');
    expect(plan.solverVersion).not.toBe('cpsat-v1');
    expect(plan.fallbackReason).toMatch(/malformed/i);
    expect(metricsService.recordFallback).toHaveBeenCalled();
    expect(plan.solverStatus).not.toMatch(/OPTIMAL|FEASIBLE/);
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it('契约内 OPTIMAL 响应仍被正常采纳（校验不过度收紧）', async () => {
    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:8000',
      timeoutMs: 50,
      fetch: stubFetch({
        json: async () => ({
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
        }),
      }),
    });
    const plan = await solver.solve(snapshot, [], opts);

    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.solverVersion).toBe('cpsat-v1');
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].taskId).toBe('t1');
  });
});
