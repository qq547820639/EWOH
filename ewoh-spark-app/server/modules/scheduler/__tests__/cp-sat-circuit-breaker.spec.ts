/* Phase 2 / P2-T4：CP-SAT 熔断器回归测试。 */
/// <reference types="jest" />
import { CpSatCircuitBreaker } from '../cp-sat-circuit-breaker';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';

describe('CpSatCircuitBreaker（纯状态机）', () => {
  it('初始 CLOSED，isOpen=false', () => {
    const cb = new CpSatCircuitBreaker({ failureThreshold: 3 });
    expect(cb.isOpen()).toBe(false);
    expect(cb.snapshot().state).toBe('CLOSED');
  });

  it('连续失败达阈值 → OPEN；isOpen=true', () => {
    const cb = new CpSatCircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    expect(cb.snapshot().state).toBe('OPEN');
  });

  it('冷却期满 → HALF_OPEN 放行一次探测；成功 → CLOSED 复位', () => {
    const cb = new CpSatCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.isOpen(0)).toBe(true);
    // 冷却期满（now 推进到 1000ms 后）。
    expect(cb.isOpen(1000)).toBe(false);
    expect(cb.snapshot().state).toBe('HALF_OPEN');
    // 探测成功 → CLOSED。
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('CLOSED');
  });
});

describe('CP-SAT 熔断器（SolverService 集成）', () => {
  beforeEach(() => {
    process.env.EWOH_SOLVER_ACTIVATION = 'PRODUCTION';
    process.env.EWOH_SOLVER_PRODUCTION_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.EWOH_SOLVER_ACTIVATION;
    delete process.env.EWOH_SOLVER_PRODUCTION_ENABLED;
  });

  const snapshot = buildSnapshot({
    persons: [seedPerson({ id: 'p1' })],
    tasks: [seedTask({ id: 't1' })],
    devices: [seedDevice({ id: 'd1' })],
  });
  const opts = { ...baseSolveOpts, policy: defaultPolicy() };

  it('连续不可达达阈值后熔断：后续 solve 跳过 worker 直接回退（fetch 不再被调用）', async () => {
    const failingFetch = jest
      .fn()
      .mockRejectedValue(new Error('network disabled in unit test')) as unknown as typeof globalThis.fetch;

    const { solver } = makeSolver({
      workerUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
      fetch: failingFetch,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    });

    // 前 2 次：worker 不可达 → UNAVAILABLE，累计熔断。
    const first = await solver.solve(snapshot, [], opts);
    const second = await solver.solve(snapshot, [], opts);
    expect(first.solverStatus).toBe('UNAVAILABLE');
    expect(second.solverStatus).toBe('UNAVAILABLE');
    expect(failingFetch).toHaveBeenCalledTimes(2);

    // 第 3 次：熔断打开 → 跳过 worker，回退启发式且 fallbackReason 明确。
    const third = await solver.solve(snapshot, [], opts);
    expect(third.solverStatus).toBe('UNAVAILABLE');
    expect(third.fallbackReason).toBe('cpsat_circuit_open');
    // 熔断后不再打 worker（fetch 仍为 2 次）。
    expect(failingFetch).toHaveBeenCalledTimes(2);
    // 回退方案仍有效。
    expect(third.solverVersion).toBe('heuristic-v2');
    expect(third.assignments.length).toBeGreaterThan(0);
  });
});
