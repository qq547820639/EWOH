/* P0-3：due/lateness 语义测试（heuristic 侧）。
 *
 * 语义（与 CP-SAT worker 对齐）：
 *   - dueMs（dueAtMs / planEnd 回退）：**软**截止——资源紧张时允许 late 分配，
 *     lateness penalty > 0 但任务仍被分配；
 *   - latestFinishMs（mustFinishByMs）：**硬**截止——无法满足时任务
 *     unassigned + violation（reason=must_finish_by_violation），绝不晚分配。
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
    latenessWeight: 3,
    walkingWeight: 1,
    workloadBalanceWeight: 1,
    stationWaitWeight: 1,
    changeCostWeight: 1,
    riskWeight: 1,
    energyWeight: 1,
    solverVersion: 'heuristic-v2',
    weights: {
      lateness: 3,
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

function baseSnapshot(taskOverrides: Record<string, unknown>): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-P0-3',
    ts: new Date(FIXED_NOW).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [
      {
        id: 'p1',
        name: 'p1',
        status: 'available',
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
        id: 't1',
        title: 't1',
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
        ...taskOverrides,
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
}

async function solve(snapshot: WorldStateSnapshot) {
  const { solver } = makeSolver();
  const opts = {
    planId: 'PLAN-P0-3',
    triggerType: 'MANUAL' as const,
    triggerEntityId: null,
    snapshotVersion: snapshot.snapshotVersion,
    horizonMinutes: 480,
    policy: fixturePolicy(),
  };
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  try {
    return await solver.solve(snapshot, [], opts);
  } finally {
    jest.restoreAllMocks();
  }
}

describe('P0-3: due 软 / mustFinishBy 硬语义（heuristic）', () => {
  it('软 due：资源紧张时允许 late 分配（lateness penalty>0 但任务被分配）', async () => {
    // 唯一人员 p1；任务时长 30min，但 dueAtMs 仅 10min 后 → 必然 late（软罚）。
    const snapshot = baseSnapshot({
      dueAtMs: FIXED_NOW + 10 * MIN,
      latestFinishMs: null,
    });
    const plan: SchedulingPlanV2 = await solve(snapshot);

    const asg = plan.assignments.find((a) => a.taskId === 't1');
    expect(asg).toBeDefined();
    // 任务被分配，但确实晚于软 due（lateness 软项 > 0）。
    const endMs = Date.parse(asg!.plannedEnd!);
    expect(endMs).toBeGreaterThan(FIXED_NOW + 10 * MIN);
    expect((plan.metrics.lateMinutes ?? 0)).toBeGreaterThan(0);
    expect(plan.scoreBreakdown?.lateness ?? 0).toBeGreaterThan(0);
    // 无硬违例：late 是软目标，不是 violation。
    expect(plan.violations.some((v) => v.reason === 'must_finish_by_violation')).toBe(false);
  });

  it('硬 mustFinishBy：无法满足 → 任务 unassigned + violation（绝不晚分配）', async () => {
    // 任务时长 30min > 硬截止 10min → 无可行候选 → unassigned。
    const snapshot = baseSnapshot({
      dueAtMs: null,
      latestFinishMs: FIXED_NOW + 10 * MIN,
    });
    const plan: SchedulingPlanV2 = await solve(snapshot);

    const asg = plan.assignments.find((a) => a.taskId === 't1');
    expect(asg).toBeUndefined();
    expect(
      plan.violations.some((v) => v.reason === 'must_finish_by_violation'),
    ).toBe(true);
    // 硬截止未被违反（任务根本没被安排）。
    expect(plan.metrics.lateMinutes ?? 0).toBe(0);
  });

  it('硬 mustFinishBy 可满足 → 正常分配（endMs <= latestFinishMs）', async () => {
    // 任务时长 30min，硬截止 60min 后 → 可满足，正常分配。
    const snapshot = baseSnapshot({
      dueAtMs: null,
      latestFinishMs: FIXED_NOW + 60 * MIN,
    });
    const plan: SchedulingPlanV2 = await solve(snapshot);

    const asg = plan.assignments.find((a) => a.taskId === 't1');
    expect(asg).toBeDefined();
    const endMs = Date.parse(asg!.plannedEnd!);
    expect(endMs).toBeLessThanOrEqual(FIXED_NOW + 60 * MIN);
    expect(
      plan.violations.some((v) => v.reason === 'must_finish_by_violation'),
    ).toBe(false);
  });
});
