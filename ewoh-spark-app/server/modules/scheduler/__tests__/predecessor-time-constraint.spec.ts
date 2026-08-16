/* P0-1：predecessor 显式时间约束测试。
 *
 * 背景：heuristic 旧实现只检查 predecessor 是否在 doneTaskIds（前置完成），
 * 但**没有**把已安排 predecessor 的 plannedEnd 作为后继 earliestStart 下界——
 * 跨人员并行场景下，后继任务可能排到前置任务结束之前（时间序被破坏）。
 *
 * 本测试构造跨人员 fixture：
 *   - 任务 A（人员 p1）与任务 B（人员 p2）并行、时长不同（B 完成更晚）；
 *   - 任务 C 依赖 A 和 B；
 *   - 断言 C.plannedStart >= max(A, B).plannedEnd。
 *
 * 同时保留既有单人员断言（t-pred → t-succ 在同一人员上串行）。
 */
/// <reference types="jest" />
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { defaultConfig } from './scheduler-test-helpers';
import type {
  SchedulingPlanV2,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';

const FIXED_NOW = 1_700_000_000_000;
const MIN = 60_000;

function fixturePolicy(): SchedulingPolicy {
  return {
    version: 1,
    latenessWeight: 1,
    walkingWeight: 1,
    workloadBalanceWeight: 1,
    stationWaitWeight: 1,
    changeCostWeight: 1,
    riskWeight: 1,
    energyWeight: 1,
    solverVersion: 'heuristic-v2',
    weights: {
      lateness: 1,
      travel: 1,
      wait: 1,
      workload: 1,
      station: 1,
      change: 1,
      risk: 1,
      energy: 1,
    },
  };
}

function makeSolver() {
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'ROUTE-FIXTURE',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback' as const,
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      fallbackReason: 'no_route_edge' as const,
      dataQuality: 'FRESH' as const,
    }),
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(fixturePolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-FIXTURE' }),
  };
  const solver = new HeuristicSchedulingSolver(
    policyService as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
  );
  return { solver };
}

function parseMs(iso: string | null): number {
  return iso ? Date.parse(iso) : NaN;
}

describe('P0-1: predecessor 显式时间约束', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('跨人员并行：C 依赖 A 和 B，C.plannedStart >= max(A,B).plannedEnd', async () => {
    const snapshot: WorldStateSnapshot = {
      snapshotVersion: 'WS-P0-1-CROSS-PERSON',
      ts: new Date(FIXED_NOW).toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [
        {
          id: 'p1',
          name: 'p1',
          status: 'AVAILABLE',
          healthStatus: 'normal',
          skills: ['work'],
          certifications: [],
          loadLevel: 0,
          fatigueLevel: 0,
          stationId: 'S1',
          zoneId: 'Z1',
          x: 0,
          y: 0,
        },
        {
          id: 'p2',
          name: 'p2',
          status: 'AVAILABLE',
          healthStatus: 'normal',
          skills: ['work'],
          certifications: [],
          loadLevel: 0,
          fatigueLevel: 0,
          stationId: 'S2',
          zoneId: 'Z2',
          x: 5,
          y: 0,
        },
      ],
      tasks: [
        // tA 在 S1（p1），tB 在 S2（p2）——真正跨人员、跨工位并行。
        {
          id: 'tA',
          title: 'tA',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S1',
          zoneId: 'Z1',
          planStart: new Date(FIXED_NOW + 5 * MIN).toISOString(),
          planEnd: new Date(FIXED_NOW + 35 * MIN).toISOString(),
          progress: 0,
          predecessorIds: [],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
        {
          id: 'tB',
          title: 'tB',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S2',
          zoneId: 'Z2',
          planStart: new Date(FIXED_NOW + 5 * MIN).toISOString(),
          // B 完成更晚（时长 60min）
          planEnd: new Date(FIXED_NOW + 65 * MIN).toISOString(),
          progress: 0,
          predecessorIds: [],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
        {
          id: 'tC',
          title: 'tC',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S1',
          zoneId: 'Z1',
          planStart: null,
          planEnd: null,
          progress: 0,
          predecessorIds: ['tA', 'tB'],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
      ],
      devices: [],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
        { id: 'S2', name: 'S2', x: 5, y: 0, capacity: 1 },
      ],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    };

    const { solver } = makeSolver();
    const opts = {
      planId: 'PLAN-P0-1',
      triggerType: 'MANUAL' as const,
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: fixturePolicy(),
    };
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const plan: SchedulingPlanV2 = await solver.solve(snapshot, [], opts);

    const asg = (taskId: string) => plan.assignments.find((a) => a.taskId === taskId)!;
    expect(asg('tA')).toBeDefined();
    expect(asg('tB')).toBeDefined();
    expect(asg('tC')).toBeDefined();

    const aEnd = parseMs(asg('tA').plannedEnd);
    const bEnd = parseMs(asg('tB').plannedEnd);
    const cStart = parseMs(asg('tC').plannedStart);

    // 核心断言：后继不早于任一前置的结束时间（跨人员也不破坏时间序）。
    expect(cStart).toBeGreaterThanOrEqual(Math.max(aEnd, bEnd));
    // 具体到本 fixture：B 完成更晚 → C 不早于 B 结束。
    expect(bEnd).toBeGreaterThan(aEnd);
    expect(cStart).toBeGreaterThanOrEqual(bEnd);
  });

  it('单人员串行（既有语义保留）：t-pred.plannedEnd <= t-succ.plannedStart', async () => {
    const snapshot: WorldStateSnapshot = {
      snapshotVersion: 'WS-P0-1-SINGLE-PERSON',
      ts: new Date(FIXED_NOW).toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [
        {
          id: 'p1',
          name: 'p1',
          status: 'AVAILABLE',
          healthStatus: 'normal',
          skills: ['work'],
          certifications: [],
          loadLevel: 0,
          fatigueLevel: 0,
          stationId: 'S1',
          zoneId: 'Z1',
          x: 0,
          y: 0,
        },
      ],
      tasks: [
        {
          id: 't-pred',
          title: 't-pred',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S1',
          zoneId: 'Z1',
          planStart: null,
          planEnd: null,
          progress: 0,
          predecessorIds: [],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
        {
          id: 't-succ',
          title: 't-succ',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S1',
          zoneId: 'Z1',
          planStart: null,
          planEnd: null,
          progress: 0,
          predecessorIds: ['t-pred'],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
      ],
      devices: [],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    };

    const { solver } = makeSolver();
    const opts = {
      planId: 'PLAN-P0-1-SINGLE',
      triggerType: 'MANUAL' as const,
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: fixturePolicy(),
    };
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const plan: SchedulingPlanV2 = await solver.solve(snapshot, [], opts);

    const pred = plan.assignments.find((a) => a.taskId === 't-pred')!;
    const succ = plan.assignments.find((a) => a.taskId === 't-succ')!;
    expect(pred).toBeDefined();
    expect(succ).toBeDefined();
    expect(parseMs(pred.plannedEnd)).toBeLessThanOrEqual(parseMs(succ.plannedStart));
  });

  it('冻结/执行中的 predecessor 也约束后继 earliestStart（lockedAssignments 快照）', async () => {
    const snapshot: WorldStateSnapshot = {
      snapshotVersion: 'WS-P0-1-FROZEN-PRED',
      ts: new Date(FIXED_NOW).toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [
        // p1 正在执行 t-locked-pred（冻结，不可再分配）；后继 t-succ 由 p2 承担。
        {
          id: 'p1',
          name: 'p1',
          status: 'AVAILABLE',
          healthStatus: 'normal',
          skills: ['work'],
          certifications: [],
          loadLevel: 0,
          fatigueLevel: 0,
          stationId: 'S1',
          zoneId: 'Z1',
          x: 0,
          y: 0,
        },
        {
          id: 'p2',
          name: 'p2',
          status: 'AVAILABLE',
          healthStatus: 'normal',
          skills: ['work'],
          certifications: [],
          loadLevel: 0,
          fatigueLevel: 0,
          stationId: 'S2',
          zoneId: 'Z2',
          x: 5,
          y: 0,
        },
      ],
      tasks: [
        // 执行中（冻结）的前置任务：planEnd 固定。
        {
          id: 't-locked-pred',
          title: 't-locked-pred',
          taskType: 'work',
          priority: 'medium',
          status: 'executing',
          assigneeId: 'p1',
          deviceId: null,
          stationId: 'S1',
          zoneId: 'Z1',
          planStart: new Date(FIXED_NOW).toISOString(),
          planEnd: new Date(FIXED_NOW + 40 * MIN).toISOString(),
          progress: 50,
          predecessorIds: [],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
        // 后继：依赖执行中的前置 → 不得早于其 planEnd 开始。
        {
          id: 't-succ',
          title: 't-succ',
          taskType: 'work',
          priority: 'medium',
          status: 'pending',
          assigneeId: null,
          deviceId: null,
          stationId: 'S2',
          zoneId: 'Z2',
          planStart: null,
          planEnd: null,
          progress: 0,
          predecessorIds: ['t-locked-pred'],
          requiredSkills: ['work'],
          requiredCertifications: [],
        },
      ],
      devices: [],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
        { id: 'S2', name: 'S2', x: 5, y: 0, capacity: 1 },
      ],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [
        {
          taskId: 't-locked-pred',
          personId: 'p1',
          deviceId: null,
          stationId: 'S1',
        },
      ],
    };

    const { solver } = makeSolver();
    const opts = {
      planId: 'PLAN-P0-1-FROZEN',
      triggerType: 'MANUAL' as const,
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: fixturePolicy(),
    };
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const plan: SchedulingPlanV2 = await solver.solve(snapshot, [], opts);

    const succ = plan.assignments.find((a) => a.taskId === 't-succ')!;
    expect(succ).toBeDefined();
    // 冻结前置的 planEnd = now+40min；后继 earliestStart 不得早于该时刻。
    expect(parseMs(succ.plannedStart)).toBeGreaterThanOrEqual(FIXED_NOW + 40 * MIN);
  });
});
