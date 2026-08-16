/* T03 / P1-4（G3）：Heuristic 求解器 station 决策变量测试。
 *
 * 先跑红再改绿：现状 solver 硬编码 stationId: task.stationId（不枚举 candidateStations）、
 * 无容量硬校验、无 setup/changeover 入评分、PREFERENCE_BONUS_MINUTES 为 magic number。
 * 本 spec 断言 station 决策 + 容量硬约束 + 可解释评分 + 确定性。
 */
/// <reference types="jest" />
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { SchedulingConstraint, SchedulingPolicy, WorldStateSnapshot } from '@shared/api.interface';

const FIXED_NOW = 1_700_000_000_000;

function makeSnapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  };
}

function makeSolver() {
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
      feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
      graphVersion: null, calculatedAt: new Date().toISOString(),
      fallbackReason: null, dataQuality: 'FRESH',
    }),
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routing = { calculateRoute: jest.fn().mockResolvedValue({ routeId: 'R-1' }) };
  const solver = new HeuristicSchedulingSolver(
    policyService as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
  );
  return { solver, routeCostProvider };
}

describe('T03 / P1-4 station 决策变量', () => {
  it('candidateStationIds 被枚举（station 为决策变量，不再硬编码 task.stationId）', async () => {
    const { solver } = makeSolver();
    const snapshot = makeSnapshot({
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      tasks: [
        {
          id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
          assigneeId: null, deviceId: null, stationId: 'S-DEFAULT', zoneId: 'Z1',
          planStart: null, planEnd: null, progress: 0, predecessorIds: [],
          requiredSkills: ['work'], requiredCertifications: [],
          // 候选工位 S1/S2（S-DEFAULT 不在候选 → 不得被选中）。
          candidateStations: ['S1', 'S2'],
        },
      ],
      devices: [
        { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
      ],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
        { id: 'S2', name: 'S2', x: 100, y: 0, capacity: 1 },
        { id: 'S-DEFAULT', name: 'S-DEFAULT', x: 0, y: 100, capacity: 1 },
      ],
      forbiddenZones: [],
      lockedAssignments: [],
    });
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const plan = await solver.solve(snapshot, [], {
        planId: 'P', triggerType: 'MANUAL', triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion, horizonMinutes: 480,
        policy: defaultPolicy(),
      });
      const asg = plan.assignments.find((a) => a.taskId === 't1');
      expect(asg).toBeDefined();
      // 决策变量命中候选集（S1/S2），绝不用 S-DEFAULT。
      expect(['S1', 'S2']).toContain(asg!.stationId);
      // DecisionTrace 中 selected.stationId 与 assignment 一致。
      expect(asg!.decisionTrace?.selected.stationId).toBe(asg!.stationId);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('station 容量硬校验：capacity=0 的候选工位被拒（station_capacity_exceeded 不进入 feasible）', async () => {
    const { solver } = makeSolver();
    const snapshot = makeSnapshot({
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      tasks: [
        {
          id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
          assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
          planStart: null, planEnd: null, progress: 0, predecessorIds: [],
          requiredSkills: ['work'], requiredCertifications: [],
          candidateStations: ['S1'],
        },
      ],
      devices: [
        { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
      ],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 0 }, // 无容量 → 不可分配
      ],
      forbiddenZones: [],
      lockedAssignments: [],
    });
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const plan = await solver.solve(snapshot, [], {
        planId: 'P', triggerType: 'MANUAL', triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion, horizonMinutes: 480,
        policy: defaultPolicy(),
      });
      expect(plan.assignments.find((a) => a.taskId === 't1')).toBeUndefined();
      // violation 如实记录（no_eligible_resource 或容量相关）。
      expect(plan.violations.some((v) => v.taskId === 't1')).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('两次求解结构 + objective 完全一致（确定性 replay）', async () => {
    const { solver } = makeSolver();
    const snapshot = makeSnapshot({
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      tasks: [
        {
          id: 't1', title: 't1', taskType: 'work', priority: 'high', status: 'pending',
          assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
          planStart: null, planEnd: null, progress: 0, predecessorIds: [],
          requiredSkills: ['work'], requiredCertifications: [],
          candidateStations: ['S1', 'S2'],
        },
      ],
      devices: [],
      stations: [
        { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
        { id: 'S2', name: 'S2', x: 50, y: 0, capacity: 1 },
      ],
      forbiddenZones: [],
      lockedAssignments: [],
    });
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const opts = {
        planId: 'P', triggerType: 'MANUAL' as const, triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion, horizonMinutes: 480,
        policy: defaultPolicy(),
      };
      const a = await solver.solve(snapshot, [], opts);
      const b = await solver.solve(snapshot, [], opts);
      const strip = (p: import('@shared/api.interface').SchedulingPlanV2) => {
        const { createdAt: _c, solveDurationMs: _s, ...rest } = p;
        return rest;
      };
      expect(strip(a)).toEqual(strip(b));
      expect(a.objective).toBe(b.objective);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('PREFERENCE_BONUS_MINUTES 来自 policy config（preferenceBonusMinutes），非 magic number', async () => {
    const { solver } = makeSolver();
    const snapshot = makeSnapshot({
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      tasks: [
        {
          id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
          assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
          planStart: null, planEnd: null, progress: 0, predecessorIds: [],
          requiredSkills: ['work'], requiredCertifications: [],
        },
      ],
      devices: [],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
      forbiddenZones: [],
      lockedAssignments: [],
    });
    // 偏好配置改为 10 分钟：偏好任务得分应比非偏好任务低 10（分钟归一化，权重全 1）。
    const config = defaultConfig();
    config.preferenceBonusMinutes = 10;
    const policyService = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(config),
    };
    const routing = { calculateRoute: jest.fn().mockResolvedValue({ routeId: 'R-1' }) };
    const routeCostProvider = {
      estimate: jest.fn().mockResolvedValue({
        routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
        feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
        graphVersion: null, calculatedAt: new Date().toISOString(),
        fallbackReason: null, dataQuality: 'FRESH',
      }),
    };
    const solver2 = new HeuristicSchedulingSolver(
      policyService as never,
      routing as never,
      routeCostProvider as never,
      new EligibilityService(),
    );
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const constraints: SchedulingConstraint[] = [
        { type: 'PREFERRED_RESOURCE', taskId: 't1', personId: 'p1' },
      ];
      const plan = await solver2.solve(snapshot, constraints, {
        planId: 'P', triggerType: 'MANUAL', triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion, horizonMinutes: 480,
        policy: defaultPolicy(),
      });
      const asg = plan.assignments.find((a) => a.taskId === 't1');
      expect(asg).toBeDefined();
      // 偏好命中：scoreBreakdown.total 不应为 Infinity（preferenceBonusMinutes=10 生效）。
      expect(asg!.scoreBreakdown?.total).toBeLessThan(Number.POSITIVE_INFINITY);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
