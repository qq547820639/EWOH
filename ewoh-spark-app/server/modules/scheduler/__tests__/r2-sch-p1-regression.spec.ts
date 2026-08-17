/* r2-sch-p1-regression.spec.ts — 二轮审计 P1 回归（R2-SCH-001/002/003）。
 *
 * - R2-SCH-001：候选引擎 startMs 按人员/设备占用顺延（与内联 heuristic 分支语义
 *   等价）——同一人员第二个任务不再被 time_conflict 拒绝。
 * - R2-SCH-002：solveVariants 变体权重必须作用于候选引擎路径（engine 消费
 *   variant policy，不再内部全局取 getActivePolicy 导致三变体趋同）。
 * - R2-SCH-003：rule-based / MILP 求解器真实解析输入约束（LOCKED/EXCLUDED/
 *   FORBIDDEN_ZONE/MIN_BATTERY），未知类型显式 violations=UNSUPPORTED_CONSTRAINT，
 *   绝不静默失效。
 */
/// <reference types="jest" />
import { CandidateEngineService } from '../candidate-engine.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { RuleBasedSchedulingSolver } from '../rule-based-scheduling-solver';
import { MilpSchedulingSolver } from '../milp-scheduling-solver';
import { SolverService } from '../solver.service';
import { EligibilityService } from '../eligibility.service';
import { SchedulingObjectiveEvaluator } from '../scheduling-objective-evaluator.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import type { WorldStateSnapshot, SchedulingConstraint } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
} from './scheduler-test-helpers';

function routeCost(etaSeconds: number) {
  return {
    routeId: `R-${etaSeconds}`,
    distanceMeters: etaSeconds * 10,
    etaSeconds,
    riskLevel: null,
    feasible: true,
    source: 'euclidean_fallback' as const,
    riskCost: 0,
    congestionCost: 0,
    graphVersion: null,
    calculatedAt: new Date().toISOString(),
    fallbackReason: null,
    dataQuality: 'FRESH' as const,
    geometry: [],
  };
}

/** 真实 CandidateEngineService（依赖全 mock；与 candidate-engine-parity.spec 同构）。 */
function makeEngine(opts: { etaByPerson?: Record<string, number> } = {}) {
  const worldState = { getCurrentWorldState: jest.fn(), buildSnapshot: jest.fn() };
  const resourceProjection = {
    projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
  };
  const routeCostProvider = {
    estimate: jest.fn(async (_personId: string) =>
      routeCost(opts.etaByPerson?.[_personId] ?? 10),
    ),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const engine = new CandidateEngineService(
    worldState as never,
    resourceProjection as never,
    new EligibilityService(),
    routeCostProvider as never,
    policy as never,
  );
  return { engine, routeCostProvider, policy };
}

const BASE_OPTS = {
  planId: 'P',
  triggerType: 'MANUAL',
  triggerEntityId: null,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
} as never;

describe('R2-SCH-001：候选引擎 startMs 按人员/设备占用顺延', () => {
  function snapshot(): WorldStateSnapshot {
    return buildSnapshot({
      persons: [seedPerson({ id: 'p1', skills: ['work'] })],
      tasks: [seedTask({ id: 't1', requiredSkills: ['work'] })],
      devices: [],
    });
  }

  it('engine 层：bookedPersonFreeAt 顺延生效（startMs = max(下界+travel, 占用结束)）', async () => {
    const { engine } = makeEngine();
    const snap = snapshot();
    const task = snap.tasks[0];

    const poolNoDefer = await engine.buildCandidatePool(task, snap, {
      nowMs: 0,
      earliestStartMs: 0,
    });
    expect(poolNoDefer[0].startMs).toBe(10 * 1000); // 0 + travel(10s)

    const poolDeferred = await engine.buildCandidatePool(task, snap, {
      nowMs: 0,
      earliestStartMs: 0,
      bookedPersonFreeAt: new Map([['p1', 3_600_000]]),
    });
    expect(poolDeferred[0].startMs).toBe(3_600_000); // 顺延到人员空闲时刻

    // 任务最早开始下界同样参与 max（与内联 earliestStartMs+travel 一致）。
    const poolLower = await engine.buildCandidatePool(task, snap, {
      nowMs: 0,
      earliestStartMs: 7_200_000,
    });
    expect(poolLower[0].startMs).toBe(7_200_000 + 10 * 1000);
  });

  it('engine 层：设备占用顺延（bookedDeviceFreeAt）', async () => {
    const { engine } = makeEngine();
    const snap = buildSnapshot({
      persons: [seedPerson({ id: 'p1', skills: ['work'] })],
      tasks: [
        {
          ...seedTask({ id: 't1', requiredSkills: ['work'] }),
          requiredDeviceCapabilities: ['lift'],
        },
      ],
      devices: [seedDevice({ id: 'd1' })],
    });
    // 设备能力由投影层 capabilities 提供；直接给设备补能力（seed 形状扩展）。
    (snap.devices[0] as unknown as { capabilities: string[] }).capabilities = ['lift'];
    const pool = await engine.buildCandidatePool(snap.tasks[0], snap, {
      nowMs: 0,
      earliestStartMs: 0,
      bookedDeviceFreeAt: new Map([['d1', 1_800_000]]),
    });
    const withDevice = pool.filter((c) => c.deviceId === 'd1' && c.eligible);
    expect(withDevice.length).toBeGreaterThan(0);
    expect(withDevice[0].startMs).toBe(1_800_000);
  });

  it('生产路径（heuristic+engine）：同一人员两个任务均可分配，第二个顺延不 time_conflict', async () => {
    const { engine } = makeEngine();
    const snap = buildSnapshot({
      persons: [seedPerson({ id: 'p1', skills: ['work'] })],
      tasks: [
        seedTask({ id: 't1', requiredSkills: ['work'] }),
        seedTask({ id: 't2', requiredSkills: ['work'] }),
      ],
      devices: [],
    });
    const solver = new HeuristicSchedulingSolver(
      { getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()), getConfig: jest.fn().mockResolvedValue(defaultConfig()) } as never,
      {} as never,
      {} as never,
      new EligibilityService(),
      undefined,
      undefined,
      undefined,
      engine,
    );
    const plan = await solver.solve(snap, [], BASE_OPTS);
    // 修复前：t2 候选 startMs=now+travel 与 t1 预订重叠 → time_conflict → 1 分配+违例。
    expect(plan.assignments).toHaveLength(2);
    expect(plan.violations).toHaveLength(0);
    const t1 = plan.assignments.find((a) => a.taskId === 't1')!;
    const t2 = plan.assignments.find((a) => a.taskId === 't2')!;
    expect(Date.parse(t2.plannedStart)).toBeGreaterThanOrEqual(Date.parse(t1.plannedEnd));
  });
});

describe('R2-SCH-002：solveVariants 变体权重作用于候选引擎路径', () => {
  it('engine 收到每个变体的缩放 policy（不再全局取 getActivePolicy）且评分随权重缩放', async () => {
    const { engine, policy, routeCostProvider } = makeEngine();
    const snap = buildSnapshot({
      persons: [seedPerson({ id: 'p1', skills: ['work'] })],
      tasks: [seedTask({ id: 't1', requiredSkills: ['work'] })],
      devices: [],
    });
    const spy = jest.spyOn(engine, 'buildCandidatePool');

    const solver = new SolverService(
      {
        ...policy,
        resolveProfiles: SchedulingPolicyService.prototype.resolveProfiles,
      } as never,
      { calculateRoute: jest.fn() } as never,
      routeCostProvider as never,
      new EligibilityService(),
      {
        workerUrl: 'http://127.0.0.1:1',
        timeoutMs: 50,
        fetch: jest.fn().mockRejectedValue(new Error('net off')),
      },
      {
        recordPlanChurn: jest.fn(),
        recordPartialReplanAffected: jest.fn(),
        recordRun: jest.fn(),
      } as never,
      engine,
    );

    const plans = await solver.solveVariants(snap, [], {
      planId: 'RUN-V',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: 'WS-TEST-0001',
      horizonMinutes: 480,
    });
    expect(plans).toHaveLength(3); // A/B/C 三变体

    // 引擎收到的 policy：A=ON_TIME(lateness×3, change×0.5)、
    // B=WORKLOAD_BALANCE(workload×3, travel×1.5, lateness×0.5)、C=BALANCED(不缩放)。
    const capturedWeights = spy.mock.calls.map(
      (call) =>
        (call[2] as unknown as { policy?: { weights: Record<string, number> } }).policy
          ?.weights,
    );
    expect(capturedWeights).toHaveLength(3);
    expect(capturedWeights.every(Boolean)).toBe(true);
    expect(capturedWeights[0]).toMatchObject({ lateness: 3, change: 0.5 });
    expect(capturedWeights[1]).toMatchObject({ workload: 3, travel: 1.5, lateness: 0.5 });
    expect(capturedWeights[2]).toMatchObject({ lateness: 1, travel: 1 });

    // 评分随变体权重缩放：B(travel×1.5) 的 travel 分项 = C 的 1.5 倍。
    const travelC = plans[2].assignments[0].scoreBreakdown!.travel;
    const travelB = plans[1].assignments[0].scoreBreakdown!.travel;
    expect(travelB).toBeCloseTo(travelC * 1.5, 6);
  });
});

describe('R2-SCH-003：rule-based / MILP 真实解析输入约束（绝不静默失效）', () => {
  function baseSnapshot(): WorldStateSnapshot {
    return buildSnapshot({
      persons: [
        seedPerson({ id: 'p1', skills: ['work'] }),
        seedPerson({ id: 'p2', skills: ['work'] }),
      ],
      devices: [],
    });
  }

  function makeRuleBased(engine: CandidateEngineService) {
    return new RuleBasedSchedulingSolver(
      { getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()), getConfig: jest.fn().mockResolvedValue(defaultConfig()) } as never,
      engine,
      new SchedulingObjectiveEvaluator(),
    );
  }

  it('LOCKED_PERSON / EXCLUDED_RESOURCE / FORBIDDEN_ZONE / MIN_BATTERY 真实执行', async () => {
    const { engine } = makeEngine();
    const snap = baseSnapshot();
    (snap as WorldStateSnapshot & { tasks: WorldStateSnapshot['tasks'] }).tasks = [
      seedTask({ id: 't1', requiredSkills: ['work'] }),
      seedTask({ id: 't2', requiredSkills: ['work'] }),
      { ...seedTask({ id: 't3', requiredSkills: ['work'] }), zoneId: 'Z9' },
      {
        ...seedTask({ id: 't4', requiredSkills: ['work'] }),
        requiredDeviceCapabilities: ['lift'],
      },
    ];
    snap.devices = [seedDevice({ id: 'd1', battery: 80 })];
    (snap.devices[0] as unknown as { capabilities: string[] }).capabilities = ['lift'];

    const solver = makeRuleBased(engine);
    const constraints: SchedulingConstraint[] = [
      { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p2' },
      { type: 'EXCLUDED_RESOURCE', taskId: 't2', personId: 'p1' },
      { type: 'FORBIDDEN_ZONE', zoneId: 'Z9' },
      { type: 'MIN_BATTERY', value: 90 },
    ];
    const plan = await solver.solve(snap, constraints, BASE_OPTS);

    const byTask = new Map(plan.assignments.map((a) => [a.taskId, a]));
    // LOCKED_PERSON：t1 锁定 p2。
    expect(byTask.get('t1')?.personId).toBe('p2');
    // EXCLUDED_RESOURCE：t2 排除 p1 → 分配 p2（字库序下本会选 p1）。
    expect(byTask.get('t2')?.personId).toBe('p2');
    // FORBIDDEN_ZONE：Z9 任务不可派（zone_forbidden）。
    expect(byTask.has('t3')).toBe(false);
    expect(
      plan.violations.some(
        (v) =>
          (v as { taskId?: string; rejectReasons?: string[] }).taskId === 't3' &&
          (v as { rejectReasons?: string[] }).rejectReasons?.includes('zone_forbidden'),
      ),
    ).toBe(true);
    // MIN_BATTERY=90 > 设备电量 80：t4（必用设备）不可派（battery_low）。
    expect(byTask.has('t4')).toBe(false);
    expect(
      plan.violations.some(
        (v) =>
          (v as { taskId?: string }).taskId === 't4' &&
          (v as { rejectReasons?: string[] }).rejectReasons?.includes('battery_low'),
      ),
    ).toBe(true);

    // 对照：无 MIN_BATTERY 约束（缺省 15）时 t4 可派（证明约束确实生效而非数据问题）。
    const planNoBattery = await solver.solve(
      snap,
      constraints.filter((c) => c.type !== 'MIN_BATTERY'),
      BASE_OPTS,
    );
    expect(planNoBattery.assignments.some((a) => a.taskId === 't4')).toBe(true);
  });

  it('未知约束类型显式 violations=UNSUPPORTED_CONSTRAINT（不静默忽略）', async () => {
    const { engine } = makeEngine();
    const snap = baseSnapshot();
    snap.tasks = [seedTask({ id: 't1', requiredSkills: ['work'] })];
    const solver = makeRuleBased(engine);
    const plan = await solver.solve(
      snap,
      [{ type: 'NOT_A_REAL_TYPE' } as unknown as SchedulingConstraint],
      BASE_OPTS,
    );
    expect(plan.violations).toEqual([
      expect.objectContaining({
        type: 'unsupported_constraint',
        constraintType: 'NOT_A_REAL_TYPE',
        reason: 'UNSUPPORTED_CONSTRAINT',
      }),
    ]);
  });

  it('MILP：约束 IR 透传候选引擎（锁定/排除/禁入区/电量覆盖），未知类型显式上报', async () => {
    const calls: Array<{ taskId: string; opts: Record<string, unknown> }> = [];
    const candidateEngine = {
      buildCandidatePool: jest.fn(
        async (t: WorldStateSnapshot['tasks'][number], _s: unknown, opts: Record<string, unknown>) => {
          calls.push({ taskId: t.id, opts });
          return [];
        },
      ),
    };
    const solver = new MilpSchedulingSolver(
      { getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()), getConfig: jest.fn().mockResolvedValue(defaultConfig()) } as never,
      candidateEngine as never,
      new SchedulingObjectiveEvaluator(),
    );
    const snap = baseSnapshot();
    snap.tasks = [seedTask({ id: 't1', requiredSkills: ['work'] })];
    const plan = await solver.solve(
      snap,
      [
        { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p2' },
        { type: 'EXCLUDED_RESOURCE', deviceId: 'd1' },
        { type: 'FORBIDDEN_ZONE', zoneId: 'Z1' },
        { type: 'MIN_BATTERY', value: 66 },
        { type: 'MAX_WORKLOAD', value: 0.5 },
        { type: 'ALIEN_TYPE' } as unknown as SchedulingConstraint,
      ],
      BASE_OPTS,
    );
    const opts = calls[0].opts as {
      lockedPersonByTask: Map<string, string>;
      excludedDeviceGlobal: Set<string>;
      forbiddenZoneIds: string[];
      minBatteryPct: number;
      maxContinuousLoad: number;
    };
    expect(opts.lockedPersonByTask.get('t1')).toBe('p2');
    expect(opts.excludedDeviceGlobal.has('d1')).toBe(true);
    expect(opts.forbiddenZoneIds).toContain('Z1');
    expect(opts.minBatteryPct).toBe(66);
    expect(opts.maxContinuousLoad).toBe(0.5);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'unsupported_constraint',
          constraintType: 'ALIEN_TYPE',
          reason: 'UNSUPPORTED_CONSTRAINT',
        }),
      ]),
    );
  });
});
