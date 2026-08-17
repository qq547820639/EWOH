/* milp-scheduling-solver.spec.ts — MILP Solver 语义锁定（ADR-058 / NO-13i，§8/§9）。
 *
 * 确定性断言：真实 HiGHS 求解（非 mock）：最优性 vs 穷举 / 容量冲突 / DAG 闭包与
 * 时序冲突 / 工位容量互斥 / 无可行显式 UNASSIGNED / 重放 deep-equal /
 * solverVersion·solverStatus 标记 / WASM 加载失败显式抛出。候选引擎以 fake 替换
 * （其真实语义由 candidate-engine 自身 spec 覆盖；本 spec 锁定 MILP 的联合行语义）。
 */
import { MilpSchedulingSolver, MILP_SOLVER_VERSION } from '../milp-scheduling-solver';
import { SchedulingObjectiveEvaluator } from '../scheduling-objective-evaluator.service';
import type { CandidateEvaluation } from '@shared/scheduler';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  buildSnapshot,
  defaultConfig,
  defaultPolicy,
  person,
  task,
} from './scheduler-test-helpers';

// HiGHS WASM 为同步编译+求解：每个用例各自构造 solver 实例（highsPromise 缓存
// per-instance），全套件并发下单测耗时易超 jest 默认 5s（WASM 编译 CPU 争用）。
// R2-SCH-005 修复后求解本身已受 time_limit 约束；此处仅放宽测试超时（基础设施
// 加固，不改变任何断言语义）。
jest.setTimeout(60_000);

function eligible(
  personId: string,
  opts: Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    personId,
    deviceId: null,
    stationId: null,
    startMs: 1_700_000_000_000,
    endMs: 1_700_001_800_000,
    eligible: true,
    rejectReasons: [],
    scoreBreakdown: { lateness: 0, travel: 5, workloadBalance: 5, stationWait: 0, changeCost: 0, risk: 0, energyCost: 0, total: 10 },
    routeCost: { personId, deviceId: null, stationId: null, etaSeconds: 300, distanceMeters: 120, congestion: 1, blocked: false, forbiddenZone: false, risk: 0, energy: 0, routeCostMode: 'route_graph', fallbackReason: null, dataQuality: 'FRESH', feasible: true },
    ...opts,
  };
}

function rejected(
  personId: string,
  reasons: string[],
  opts: Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    personId,
    deviceId: null,
    stationId: null,
    startMs: 1_700_000_000_000,
    endMs: 1_700_001_800_000,
    eligible: false,
    rejectReasons: reasons as never[],
    scoreBreakdown: { lateness: 0, travel: 0, workloadBalance: 0, stationWait: 0, changeCost: 0, risk: 0, energyCost: 0, total: Infinity },
    routeCost: null,
    ...opts,
  };
}

/** cost 便捷构造：scoreBreakdown.total = cost（MILP 目标成本）。 */
function withCost(c: CandidateEvaluation, cost: number): CandidateEvaluation {
  return { ...c, scoreBreakdown: { ...c.scoreBreakdown, total: cost } };
}

function makeSolver(
  pools: Record<string, CandidateEvaluation[]>,
  loader?: () => Promise<never>,
) {
  const candidateEngine = {
    buildCandidatePool: jest.fn(
      async (t: WorldStateSnapshot['tasks'][number]) => pools[t.id] ?? [],
    ),
  };
  const policyService = {
    getActivePolicy: jest.fn(async () => defaultPolicy()),
    getConfig: jest.fn(async () => defaultConfig()),
  };
  const solver = new MilpSchedulingSolver(
    policyService as never,
    candidateEngine as never,
    new SchedulingObjectiveEvaluator(),
    loader as never,
  );
  return { solver };
}

const OPTS = {
  planId: 'PLAN-MILP-1',
  triggerType: 'MANUAL',
  triggerEntityId: null,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
} as never;

function snapshotWith(tasks: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): WorldStateSnapshot {
  return buildSnapshot({
    tasks: tasks as never,
    persons: [
      person({ id: 'p1', skills: ['work'] }),
      person({ id: 'p2', skills: ['work'] }),
    ],
    ...overrides,
  });
}

/** 穷举全部联合分配（每任务至多一候选），返回字典序最优（先最大化分配数、再最小成本，
 *  与 MILP 的 M 目标语义一致——ADR-058 决策 1）分配集。 */
function bruteForceOptimum(
  taskIds: string[],
  pools: Record<string, CandidateEvaluation[]>,
): { assignments: Map<string, string>; cost: number } {
  let best: { assignments: Map<string, string>; count: number; cost: number } | null = null;
  const recurse = (idx: number, current: Map<string, string>, cost: number) => {
    if (idx === taskIds.length) {
      if (
        !best ||
        current.size > best.count ||
        (current.size === best.count && cost < best.cost)
      ) {
        best = { assignments: new Map(current), count: current.size, cost };
      }
      return;
    }
    const tid = taskIds[idx];
    recurse(idx + 1, current, cost); // 该任务不分配
    for (const c of pools[tid] ?? []) {
      current.set(tid, c.personId);
      recurse(idx + 1, current, cost + c.scoreBreakdown.total);
      current.delete(tid);
    }
  };
  recurse(0, new Map(), 0);
  return { assignments: best!.assignments, cost: best!.cost };
}

describe('MilpSchedulingSolver（ADR-058 / NO-13i）', () => {
  it('真实 HiGHS 求解：单任务最优候选（成本 argmin）+ 标记如实（§33）', async () => {
    const snapshot = snapshotWith([task({ id: 'task-1' })]);
    const { solver } = makeSolver({
      'task-1': [withCost(eligible('p1'), 10), withCost(eligible('p2'), 5)],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(1);
    const a = plan.assignments[0];
    expect(a.personId).toBe('p2');
    expect(plan.solverVersion).toBe(MILP_SOLVER_VERSION);
    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(plan.status).toBe('shadow');
    expect(a.decisionTrace?.selectedReason).toEqual(['milp:exact-optimal']);
    expect(a.reasons).toEqual(['milp:exact-optimal']);
    expect(a.plannedStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(a.etaSeconds).toBe(300);
  });

  it('最优性 vs 穷举：2 任务 × 2 人员无冲突 → 联合最小成本分配（精确最优，§9 差异边界）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2' }),
    ]);
    const pools = {
      'task-1': [
        withCost(eligible('p1', { startMs: 1000, endMs: 2000 }), 6),
        withCost(eligible('p2', { startMs: 1000, endMs: 2000 }), 4),
      ],
      'task-2': [
        withCost(eligible('p1', { startMs: 3000, endMs: 4000 }), 3),
        withCost(eligible('p2', { startMs: 3000, endMs: 4000 }), 9),
      ],
    };
    const { solver } = makeSolver(pools);
    const plan = await solver.solve(snapshot, [], OPTS);
    const optimum = bruteForceOptimum(['task-1', 'task-2'], pools);
    // 唯一最优：task-1→p2（4）+ task-2→p1（3）= 7。
    expect(optimum.cost).toBe(7);
    expect(plan.assignments).toHaveLength(2);
    const got = new Map(plan.assignments.map((a) => [a.taskId, a.personId]));
    expect(got.get('task-1')).toBe('p2');
    expect(got.get('task-2')).toBe('p1');
  });

  it('容量冲突：1 人员 2 重叠任务 → 分配数最大化（1 分配 + 显式 UNASSIGNED_MILP，§33 不伪造）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2' }),
    ]);
    const { solver } = makeSolver({
      'task-1': [withCost(eligible('p1', { startMs: 0, endMs: 60_000 }), 5)],
      'task-2': [withCost(eligible('p1', { startMs: 30_000, endMs: 90_000 }), 5)],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.violations).toHaveLength(1);
    expect(plan.violations[0]).toEqual(
      expect.objectContaining({
        type: 'UNASSIGNED_MILP',
        reason: 'no_feasible_assignment_milp',
        eligibleCandidateCount: 1,
      }),
    );
  });

  it('DAG 闭包：前置无可行候选 → 后继显式封锁（predecessor_unassigned，与 rule-based 同语义 §31）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2', predecessorIds: ['task-1'] }),
    ]);
    const { solver } = makeSolver({
      'task-1': [],
      'task-2': [eligible('p2')],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual([
      expect.objectContaining({ type: 'UNASSIGNED_MILP', taskId: 'task-1', reason: 'no_eligible_candidate' }),
      expect.objectContaining({ type: 'UNASSIGNED_MILP', taskId: 'task-2', reason: 'predecessor_unassigned' }),
    ]);
  });

  it('DAG 时序冲突：前置结束 > 后继开始 → 冲突对互斥，精确最优保留低成本任务', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2', predecessorIds: ['task-1'] }),
    ]);
    const { solver } = makeSolver({
      'task-1': [withCost(eligible('p1', { startMs: 0, endMs: 60_000 }), 1)],
      'task-2': [withCost(eligible('p2', { startMs: 30_000, endMs: 90_000 }), 100)],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    // task-1 成本 1 < task-2 成本 100 → 分配 task-1，task-2 显式违例。
    expect(plan.assignments.map((a) => a.taskId)).toEqual(['task-1']);
    expect(plan.violations).toEqual([
      expect.objectContaining({ type: 'UNASSIGNED_MILP', taskId: 'task-2', reason: 'no_feasible_assignment_milp' }),
    ]);
  });

  it('工位容量互斥：容量 1 工位 + 2 人员重叠 → 工位独占行生效', async () => {
    const snapshot = snapshotWith(
      [
        task({ id: 'task-1' }),
        task({ id: 'task-2' }),
      ],
      {
        stations: [{ id: 'st1', x: 0, y: 0, capacity: 1 }],
      },
    );
    const { solver } = makeSolver({
      'task-1': [withCost(eligible('p1', { stationId: 'st1', startMs: 0, endMs: 60_000 }), 5)],
      'task-2': [withCost(eligible('p2', { stationId: 'st1', startMs: 30_000, endMs: 90_000 }), 5)],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.violations).toHaveLength(1);
    expect(plan.violations[0]).toEqual(
      expect.objectContaining({ type: 'UNASSIGNED_MILP', reason: 'no_feasible_assignment_milp' }),
    );
  });

  it('确定性重放：同输入两轮 deep-equal（同环境重放锁定，§9）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2' }),
    ]);
    const pools = {
      'task-1': [withCost(eligible('p1', { startMs: 0, endMs: 60_000 }), 5), withCost(eligible('p2', { startMs: 0, endMs: 60_000 }), 7)],
      'task-2': [withCost(eligible('p1', { startMs: 120_000, endMs: 180_000 }), 2)],
    };
    const { solver } = makeSolver(pools);
    const a = await solver.solve(snapshot, [], OPTS);
    const b = await solver.solve(snapshot, [], OPTS);
    const strip = (p: Record<string, unknown>) => ({ ...p, solveDurationMs: 0, createdAt: '' });
    expect(strip(a as never)).toEqual(strip(b as never));
    expect(a.assignments.map((x) => x.personId)).toEqual(b.assignments.map((x) => x.personId));
  });

  it('无可行变量（空任务集）→ 空方案不调用求解器（trivial 最优，§33 不伪造）', async () => {
    const snapshot = snapshotWith([]);
    const loader = jest.fn();
    const { solver } = makeSolver({}, loader as never);
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toHaveLength(0);
    expect(plan.solverStatus).toBe('OPTIMAL');
    expect(loader).not.toHaveBeenCalled();
  });

  it('HiGHS 加载失败 → 显式抛出（绝不静默降级，§33）', async () => {
    const snapshot = snapshotWith([task({ id: 'task-1' })]);
    const { solver } = makeSolver(
      { 'task-1': [eligible('p1')] },
      jest.fn().mockRejectedValue(new Error('wasm blocked')) as never,
    );
    await expect(solver.solve(snapshot, [], OPTS)).rejects.toThrow(
      /milp-v1: HiGHS WASM 加载失败：wasm blocked/,
    );
  });
});
