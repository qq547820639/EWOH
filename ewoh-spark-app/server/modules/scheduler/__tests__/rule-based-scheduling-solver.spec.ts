/* rule-based-scheduling-solver.spec.ts — Rule-based Solver 语义锁定（ADR-053 / NO-13d，§8/§9）。
 *
 * 确定性断言：重放 deep-equal / 任务序（due→priority→id）/ 硬约束拒绝 /
 * DAG 前置序 / 无可行显式 UNASSIGNED / solverVersion·solverStatus 标记 /
 * 预订累积透传 / routeCost 映射。候选引擎以 fake 替换（其真实语义由
 * candidate-engine 自身 spec 覆盖；本 spec 锁定 rule-based 的组合规则）。
 */
import { RuleBasedSchedulingSolver, RULE_BASED_SOLVER_VERSION } from '../rule-based-scheduling-solver';
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

function makeSolver(pools: Record<string, CandidateEvaluation[]>) {
  const calls: Array<{ taskId: string; opts: Record<string, unknown>; bookedTimeSlotsLen: number }> = [];
  const candidateEngine = {
    buildCandidatePool: jest.fn(async (t: WorldStateSnapshot['tasks'][number], _snapshot: unknown, opts: Record<string, unknown>) => {
      calls.push({
        taskId: t.id,
        opts,
        // 调用时刻快照（求解器此后会继续累积预订——记录长度而非引用，避免共享可变数组）。
        bookedTimeSlotsLen: Array.isArray(opts.bookedTimeSlots) ? opts.bookedTimeSlots.length : 0,
      });
      return pools[t.id] ?? [];
    }),
  };
  const policyService = {
    getActivePolicy: jest.fn(async () => defaultPolicy()),
    getConfig: jest.fn(async () => defaultConfig()),
  };
  const solver = new RuleBasedSchedulingSolver(
    policyService as never,
    candidateEngine as never,
    new SchedulingObjectiveEvaluator(),
  );
  return { solver, calls };
}

const OPTS = {
  planId: 'PLAN-RB-1',
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

describe('RuleBasedSchedulingSolver（ADR-053 / NO-13d）', () => {
  it('确定性重放：同输入两轮 deep-equal（幂等可重放，§9）', async () => {
    const snapshot = snapshotWith([task({ id: 'task-1' })]);
    const { solver } = makeSolver({ 'task-1': [eligible('p1')] });
    const a = await solver.solve(snapshot, [], OPTS);
    const b = await solver.solve(snapshot, [], OPTS);
    // solveDurationMs 为墙钟测量非语义——语义层（分配/轨迹/指标）deep-equal。
    // solveDurationMs/createdAt 为墙钟测量/生成时间非语义——语义层 deep-equal。
    const strip = (p: Record<string, unknown>) => ({ ...p, solveDurationMs: 0, createdAt: '' });
    expect(strip(a as never)).toEqual(strip(b as never));
    expect(a.solverVersion).toBe(RULE_BASED_SOLVER_VERSION);
    expect(a.solverStatus).toBe('RULE_BASED');
    expect(a.status).toBe('shadow');
  });

  it('任务序（ADR-053 决策 1）：due 升序 → priority 降序 → id 字典序（确定性）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-c', planEnd: '2026-08-16T10:00:00Z' }),
      task({ id: 'task-b', planEnd: '2026-08-16T09:00:00Z' }),
      task({ id: 'task-a', planEnd: '2026-08-16T08:00:00Z' }),
    ]);
    const { solver, calls } = makeSolver({
      'task-a': [eligible('p1')],
      'task-b': [eligible('p1')],
      'task-c': [eligible('p1')],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    // due 升序：a → b → c（单人员，预订累积不影响 eligibility——fake 引擎不看 slots）。
    expect(plan.assignments.map((x) => x.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
    // 第二/三个任务调用携带累积预订（人员时间槽透传）。
    expect(calls[1].bookedTimeSlotsLen).toBe(1);
    expect(calls[2].bookedTimeSlotsLen).toBe(2);
  });

  it('priority 同 due 时降序优先（确定性 tie-break）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-low', priority: 'low', planEnd: '2026-08-16T08:00:00Z' }),
      task({ id: 'task-high', priority: 'high', planEnd: '2026-08-16T08:00:00Z' }),
    ]);
    const { solver } = makeSolver({
      'task-low': [eligible('p1')],
      'task-high': [eligible('p2')],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments.map((x) => x.taskId)).toEqual(['task-high', 'task-low']);
  });

  it('first-eligible + 硬约束拒绝可解释（rejectedHard 结构化原因）', async () => {
    const snapshot = snapshotWith([task({ id: 'task-1', requiredSkills: ['forklift'] })]);
    const { solver } = makeSolver({
      'task-1': [
        rejected('p1', ['skill-mismatch']),
        eligible('p2'),
      ],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(1);
    const a = plan.assignments[0];
    expect(a.personId).toBe('p2');
    expect(a.decisionTrace?.selectedReason).toEqual(['rule-based:first-eligible']);
    expect(a.decisionTrace?.rejectedHard).toEqual([
      expect.objectContaining({ personId: 'p1', rejectReasons: ['skill-mismatch'] }),
    ]);
    expect(a.decisionTrace?.weightsSnapshot).toEqual(defaultPolicy().weights);
    expect(a.reasons).toEqual(['rule-based:first-eligible']);
  });

  it('DAG 前置：predecessor 未完成的任务不先行分配；前置无可行 → 显式 UNASSIGNED（§33 不伪造）', async () => {
    const snapshot = snapshotWith([
      task({ id: 'task-1' }),
      task({ id: 'task-2', predecessorIds: ['task-1'] }),
    ]);
    const { solver } = makeSolver({
      'task-1': [], // 无可行候选
      'task-2': [eligible('p2')],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual([
      expect.objectContaining({ type: 'UNASSIGNED_RULE_BASED', taskId: 'task-1', reason: 'no_eligible_candidate' }),
      expect.objectContaining({ type: 'UNASSIGNED_RULE_BASED', taskId: 'task-2', reason: 'predecessor_unassigned' }),
    ]);
  });

  it('lockedAssignments（快照真实事实）→ lockedPersonByTask 透传候选引擎', async () => {
    const snapshot = snapshotWith(
      [task({ id: 'task-1' })],
      { lockedAssignments: [{ taskId: 'task-1', personId: 'p1', deviceId: null, stationId: null }] },
    );
    const { solver, calls } = makeSolver({ 'task-1': [eligible('p1')] });
    await solver.solve(snapshot, [], OPTS);
    expect(calls[0].opts.lockedPersonByTask).toBeInstanceOf(Map);
    expect((calls[0].opts.lockedPersonByTask as Map<string, string>).get('task-1')).toBe('p1');
  });

  it('routeCost 映射：eta/distance 落 assignment；riskLevel 原样透传（R2-SCH-017：medium 不再折叠丢失）', async () => {
    const snapshot = snapshotWith([task({ id: 'task-1' })]);
    const { solver } = makeSolver({
      'task-1': [
        eligible('p1', {
          routeCost: { personId: 'p1', deviceId: null, stationId: null, etaSeconds: 420, distanceMeters: 200, congestion: 1, blocked: false, forbiddenZone: false, risk: 0.5, riskLevel: 'medium', energy: 0, routeCostMode: 'route_graph', fallbackReason: null, dataQuality: 'FRESH', feasible: true },
        }),
      ],
    });
    const plan = await solver.solve(snapshot, [], OPTS);
    expect(plan.assignments[0].etaSeconds).toBe(420);
    expect(plan.assignments[0].distanceMeters).toBe(200);
    // R2-SCH-017：不再折叠为 risk>0?'high'——routeCost.riskLevel 原样透传。
    expect(plan.assignments[0].riskLevel).toBe('medium');
  });
});
