/* P0-5：SchedulingObjectiveEvaluator 独立评估器测试。
 *
 * 验证：
 *   1. 同一 snapshot+assignments 喂 evaluator → 输出确定（与求解器无关）；
 *   2. heuristic 与 CP-SAT 路径均调用 evaluator，metrics/scoreBreakdown 对应各自 assignments；
 *   3. CP-SAT 路径不再复用 heuristic shell（metrics 基于 CP-SAT assignments）。
 */
/// <reference types="jest" />
import type { SolverResponse } from '@shared/api.interface';
import { CpSatSchedulingSolver } from '../cp-sat-scheduling-solver';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { SchedulingObjectiveEvaluator } from '../scheduling-objective-evaluator.service';
import { EligibilityService } from '../eligibility.service';
import {
  person as seedPerson,
  task as seedTask,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  defaultConfig,
} from './scheduler-test-helpers';

const FIXED_NOW = 1_700_000_000_000;
const MIN = 60_000;

function buildAssignments(): Array<import('@shared/api.interface').SchedulingAssignment> {
  return [
    {
      assignmentId: 'ASG-1',
      taskId: 't1',
      personId: 'p1',
      deviceId: null,
      stationId: 'S1',
      zoneId: null,
      plannedStart: new Date(FIXED_NOW + 5 * MIN).toISOString(),
      plannedEnd: new Date(FIXED_NOW + 35 * MIN).toISOString(),
      routeId: null,
      etaSeconds: 60,
      distanceMeters: 120,
      riskLevel: null,
      status: 'proposed',
      reasons: [],
      alternatives: [],
    },
    {
      assignmentId: 'ASG-2',
      taskId: 't2',
      personId: 'p2',
      deviceId: null,
      stationId: 'S2',
      zoneId: null,
      plannedStart: new Date(FIXED_NOW + 10 * MIN).toISOString(),
      plannedEnd: new Date(FIXED_NOW + 70 * MIN).toISOString(),
      routeId: null,
      etaSeconds: 90,
      distanceMeters: 200,
      riskLevel: null,
      status: 'proposed',
      reasons: [],
      alternatives: [],
    },
  ];
}

function buildSnapshotForEval() {
  return buildSnapshot({
    persons: [
      seedPerson({ id: 'p1' }),
      seedPerson({ id: 'p2' }),
    ],
    tasks: [
      {
        ...seedTask({ id: 't1' }),
        stationId: 'S1',
        dueAtMs: FIXED_NOW + 40 * MIN, // t1 准时（end=35min）
      },
      {
        ...seedTask({ id: 't2' }),
        stationId: 'S2',
        dueAtMs: FIXED_NOW + 30 * MIN, // t2 晚 40min（end=70min）
      },
    ],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
      { id: 'S2', name: 'S2', x: 5, y: 0, capacity: 1 },
    ],
  });
}

describe('P0-5: SchedulingObjectiveEvaluator', () => {
  it('同一 snapshot+assignments → 输出确定（两次一致）', () => {
    const evaluator = new SchedulingObjectiveEvaluator();
    const snapshot = buildSnapshotForEval();
    const assignments = buildAssignments();
    const input = {
      snapshot,
      assignments,
      policy: defaultPolicy(),
      constraints: [],
      horizonMinutes: 480,
      nowMs: FIXED_NOW,
    };
    const a = evaluator.evaluate(input);
    const b = evaluator.evaluate(input);
    // LOW-3：同输入两次 evaluate 输出完全相等（不 mock Date——baselineDelta 必须
    // 只用入参 nowMs 判定 baselineLate，绝不依赖 Date.now()）。
    expect(a).toEqual(b);
    // 更强的确定性探针：给任务设 planEnd 在"真实当前时刻"之前、但在入参 nowMs
    // 之后——旧实现用 Date.now() 会把该任务计入 baselineLate，导致 lateMinutesDelta
    // 被错误扣减；修复后 baselineLate 恒 0。
    const pastRelativeToRealNow = buildSnapshotForEval();
    pastRelativeToRealNow.tasks = pastRelativeToRealNow.tasks.map((t) => ({
      ...t,
      // FIXED_NOW=2023-11-14；真实 Date.now()≈2026 → 该 planEnd 对 Date.now() 是过去，
      // 对入参 nowMs=FIXED_NOW 是未来。
      planEnd: new Date(FIXED_NOW + 5 * MIN).toISOString(),
    }));
    const out = evaluator.evaluate({
      ...input,
      snapshot: pastRelativeToRealNow,
    });
    // baselineLate=0 → lateMinutesDelta 必须等于 metrics.lateMinutes（不被 Date.now() 扣减）。
    expect(out.baselineDelta.lateMinutesDelta).toBe(out.metrics.lateMinutes);
    expect(a).toEqual(b);
    // objective == scoreBreakdown.total
    expect(a.objective).toBe(a.scoreBreakdown.total);
  });

  it('metrics 由 assignments 推导：late/walking/wait/maxWorkload/changeCost', () => {
    const evaluator = new SchedulingObjectiveEvaluator();
    const snapshot = buildSnapshotForEval();
    const assignments = buildAssignments();
    const out = evaluator.evaluate({
      snapshot,
      assignments,
      policy: defaultPolicy(),
      constraints: [],
      horizonMinutes: 480,
      nowMs: FIXED_NOW,
    });
    // t2 晚 40min → lateMinutes=40
    expect(out.metrics.lateMinutes).toBe(40);
    // walking = 120 + 200 = 320
    expect(out.metrics.walkingMeters).toBe(320);
    // t1 wait=5min（start 5min, earliest=now），t2 wait=10min（start 10min, earliest=now）
    expect(out.metrics.stationWaitMinutes).toBe(15);
    // t1 30min, t2 60min → maxWorkload=60
    expect(out.metrics.maxWorkload).toBe(60);
    // 无 baseline → changeCost=0
    expect(out.metrics.changeCost).toBe(0);
    // scoreBreakdown.lateness = 40min（权重 lateness=1）
    expect(out.scoreBreakdown.lateness).toBe(40);
    // travel = (60s + 90s) * 1000 / 60000 = 2.5
    expect(out.scoreBreakdown.travel).toBeCloseTo(2.5);
  });

  it('baseline 变化 → changeCost>0（churn 语义）', () => {
    const evaluator = new SchedulingObjectiveEvaluator();
    const snapshot = buildSnapshotForEval();
    const out = evaluator.evaluate({
      snapshot,
      assignments: buildAssignments(),
      policy: defaultPolicy(),
      constraints: [],
      baseline: new Map([
        ['t1', 'p9'], // 基线 p9 ≠ 当前 p1 → change
      ]),
      horizonMinutes: 480,
      nowMs: FIXED_NOW,
    });
    expect(out.metrics.changeCost).toBe(1);
    expect(out.scoreBreakdown.changeCost).toBe(1);
  });

  it('CP-SAT 路径 metrics 基于 CP-SAT assignments（不再复用 heuristic shell）', async () => {
    const response: SolverResponse = {
      solverVersion: 'cpsat-v1',
      solverStatus: 'OPTIMAL',
      solveDurationMs: 12,
      objective: 99,
      objectiveBreakdown: { lateness: 40, travel: 2.5 },
      hardViolations: [],
      optimalityGap: 0,
      unassignedTaskIds: [],
      // CP-SAT 只返回 t1（t2 未分配）——metrics 必须只反映 t1。
      assignments: [
        {
          taskId: 't1',
          personId: 'p1',
          deviceId: null,
          stationId: 'S1',
          startMs: FIXED_NOW + 5 * MIN,
          endMs: FIXED_NOW + 35 * MIN,
          reasons: ['cpsat-selected'],
          rejectedAlternatives: [],
        },
      ],
    };
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      json: async () => response,
    }) as unknown as typeof globalThis.fetch;

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
    // 无 travelCostService → candidateCosts 为空；CP-SAT assignment 无 eta/distance。
    const solver = new CpSatSchedulingSolver(
      heuristic,
      { workerUrl: 'http://127.0.0.1:8000', timeoutMs: 50, fetch },
      undefined,
      undefined,
    );
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [
        {
          ...seedTask({ id: 't1' }),
          stationId: 'S1',
          dueAtMs: FIXED_NOW + 40 * MIN,
        },
      ],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
    });
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const plan = await solver.solve(snapshot, [], {
        ...baseSolveOpts,
        policy: defaultPolicy(),
      });
      // metrics 只反映 CP-SAT 的 1 个 assignment（t1，准时，0 late）。
      expect(plan.assignments).toHaveLength(1);
      expect(plan.metrics.lateMinutes).toBe(0);
      expect(plan.metrics.walkingMeters).toBe(0);
      // objective 保留 worker 返回值（不是 heuristic objective）。
      expect(plan.objective).toBe(99);
      // scoreBreakdown 来自 evaluator（基于 CP-SAT assignments）。
      expect(plan.scoreBreakdown).toBeDefined();
      expect(plan.scoreBreakdown!.lateness).toBe(0);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('heuristic 路径 plan.metrics 也由 evaluator 计算（late 语义一致）', async () => {
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
    const solver = new HeuristicSchedulingSolver(
      policy as never,
      routing as never,
      routeCostProvider as never,
      new EligibilityService(),
    );
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [
        {
          ...seedTask({ id: 't1' }),
          stationId: 'S1',
          // 软 due 很紧：p1 只能在 now 出发（travel 10s），30min 后完成 → late ~30min。
          dueAtMs: FIXED_NOW + 1 * MIN,
        },
      ],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
    });
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const plan = await solver.solve(snapshot, [], {
        ...baseSolveOpts,
        policy: defaultPolicy(),
      });
      expect(plan.assignments).toHaveLength(1);
      // evaluator 统一计算：lateMinutes 反映 assignments 相对软 due 的延迟。
      expect(plan.metrics.lateMinutes).toBeGreaterThan(0);
      expect(plan.scoreBreakdown?.lateness ?? 0).toBeGreaterThan(0);
      expect(plan.objective).toBe(plan.scoreBreakdown?.total);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
