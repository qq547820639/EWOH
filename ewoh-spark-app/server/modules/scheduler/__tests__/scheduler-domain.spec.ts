import { EligibilityService } from '../eligibility.service';
import { SolverService, type SolverConstraint, type SolveOptions } from '../solver.service';
import { RoutingService } from '../routing.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { WorldStateSnapshotService } from '../world-state.service';
import type { WorldStateSnapshot, SchedulingPolicy } from '@shared/api.interface';
import {
  ewohRouteNode,
  ewohRouteEdge,
  ewohWorldStateSnapshot,
  ewohPersonnel,
  ewohDevice,
  ewohProductionTask,
  ewohSpatialEntity,
  ewohEvent,
  ewohResourceReservation,
  ewohDeviceBinding,
  ewohSchedulingPlanAssignment,
} from '@server/database/schema';

/* ===== 测试数据构造辅助 ===== */

interface PersonSeed {
  id: string;
  skills?: string[];
  load?: number;
  status?: string;
}

interface TaskSeed {
  id: string;
  taskType?: string;
  priority?: string;
  status?: string;
  planStart?: string | null;
  planEnd?: string | null;
  predecessorIds?: string[];
}

interface DeviceSeed {
  id: string;
  online?: boolean;
  battery?: number;
}

function person(seed: PersonSeed) {
  return {
    id: seed.id,
    name: seed.id,
    status: seed.status ?? 'AVAILABLE',
    healthStatus: 'normal',
    skills: seed.skills ?? ['work'],
    certifications: [],
    loadLevel: seed.load ?? 0,
    fatigueLevel: 0,
    stationId: null,
    zoneId: null,
    x: 0,
    y: 0,
  };
}

function task(seed: TaskSeed) {
  return {
    id: seed.id,
    title: seed.id,
    taskType: seed.taskType ?? 'work',
    priority: seed.priority ?? 'medium',
    status: seed.status ?? 'pending',
    assigneeId: null,
    deviceId: null,
    stationId: null,
    zoneId: null,
    planStart: seed.planStart ?? null,
    planEnd: seed.planEnd ?? null,
    progress: 0,
    predecessorIds: seed.predecessorIds ?? [],
    requiredSkills: [seed.taskType ?? 'work'],
    requiredCertifications: [],
  };
}

function device(seed: DeviceSeed) {
  return {
    id: seed.id,
    workerName: null,
    deviceModel: null,
    batteryPct: seed.battery ?? 100,
    online: seed.online ?? true,
    status: 'AVAILABLE',
  };
}

function buildSnapshot(overrides: Partial<WorldStateSnapshot>): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
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

const baseSolveOpts: SolveOptions = {
  planId: 'P',
  triggerType: 'MANUAL',
  triggerEntityId: null,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
};

function makeSolver() {
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-TEST' }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue({
      configVersion: 1,
      minBatteryPct: 15,
      maxContinuousLoad: 0.9,
      defaultTaskDurationMs: 1_800_000,
      horizonMinutes: 480,
      walkingSpeedMps: 1,
      euclideanDistanceWeight: 1,
      congestedFactor: 1.5,
      blockedFactor: 2,
      highRiskFactor: 2,
      mediumRiskFactor: 1.3,
      triggerCooldownMs: 30_000,
      priority: {
        deadlineRiskWeight: 1,
        waitingAgeWeight: 0.5,
        eventSeverityWeight: 1,
        productionImpactWeight: 1,
        downstreamBlockingWeight: 1,
        manualBoostWeight: 1,
        agingBaseMs: 3_600_000,
      },
    }),
    // P1-C：resolveProfiles 与生产逻辑一致（纯函数，无 DB 依赖）。
    resolveProfiles: SchedulingPolicyService.prototype.resolveProfiles,
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
  const solver = new SolverService(
    policy as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
    undefined,
    {
      recordPlanChurn: jest.fn(),
      recordPartialReplanAffected: jest.fn(),
      recordRun: jest.fn(),
      recordFallback: jest.fn(),
      recordSolverTimeout: jest.fn(),
      recordCandidateCount: jest.fn(),
      recordHardReject: jest.fn(),
    } as never,
    undefined as never, // candidateEngine：显式 undefined 保持启发式内联候选路径（行为与旧构造一致）。
  );
  return { solver, routing };
}

/* ===== Scenario 1: 技能不匹配 ===== */

describe('EligibilityService.check', () => {
  const svc = new EligibilityService();
  const ctx = {
    now: 0,
    bookedTimeSlots: [],
    bookedDeviceSlots: [],
    bookedStationSlots: [],
    lockedPersonIds: [],
    forbiddenZones: [],
    minBatteryPct: 15,
    maxContinuousLoad: 0.9,
    safetyBlockedPersonIds: [],
    predecessorDone: () => true,
    candidateStartMs: 0,
    candidateEndMs: 0,
  };

  it('S1 技能不匹配人员不能被调度 → eligible=false 且原因含 missing_skill', () => {
    const result = svc.check(
      {
        id: 'p1',
        status: 'AVAILABLE',
        skills: ['welding'],
        certifications: [],
        stationId: null,
        loadLevel: 0,
        fatigueLevel: 0,
        healthStatus: 'normal',
      },
      {
        id: 't1',
        taskType: 'work',
        requiredSkills: ['work'],
        requiredCertifications: [],
        stationId: null,
        zoneId: null,
        predIds: [],
      },
      null,
      ctx,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('missing_skill');
  });

  it('技能匹配且状态可用时判定为可调度', () => {
    const result = svc.check(
      {
        id: 'p1',
        status: 'AVAILABLE',
        skills: ['work'],
        certifications: [],
        stationId: null,
        loadLevel: 0,
        fatigueLevel: 0,
        healthStatus: 'normal',
      },
      {
        id: 't1',
        taskType: 'work',
        requiredSkills: ['work'],
        requiredCertifications: [],
        stationId: null,
        zoneId: null,
        predIds: [],
      },
      null,
      ctx,
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

/* ===== Scenario 2 & 3: 人员/设备不能重叠占用 ===== */

describe('SolverService 资源不重叠约束', () => {
  it('S2 同一个人不能同时执行两个任务（两次分配时间不重叠）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' })],
      tasks: [
        task({ id: 't1' }),
        task({ id: 't2' }),
      ],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.every((a) => a.personId === 'p1')).toBe(true);

    const sorted = [...plan.assignments].sort(
      (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
    );
    expect(Date.parse(sorted[0].plannedEnd!)).toBeLessThanOrEqual(
      Date.parse(sorted[1].plannedStart!),
    );
  });

  it('S3 同一个设备不能被两个任务同时占用（设备占用时间不重叠）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' })],
      tasks: [
        task({ id: 't1' }),
        task({ id: 't2' }),
      ],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.every((a) => a.deviceId === 'd1')).toBe(true);

    const sorted = [...plan.assignments].sort(
      (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
    );
    expect(Date.parse(sorted[0].plannedEnd!)).toBeLessThanOrEqual(
      Date.parse(sorted[1].plannedStart!),
    );
  });
});

/* ===== Scenario 5: 高优先级任务优先 ===== */

describe('SolverService 优先级排序', () => {
  it('S5 高优先级任务优先被调度（占用更早的时间窗）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' })],
      tasks: [
        task({ id: 't-low', priority: 'low' }),
        task({ id: 't-critical', priority: 'critical' }),
      ],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    const startOf = (taskId: string) => {
      const a = plan.assignments.find((x) => x.taskId === taskId)!;
      return Date.parse(a.plannedStart!);
    };
    expect(plan.assignments).toHaveLength(2);
    expect(startOf('t-critical')).toBeLessThan(startOf('t-low'));
  });
});

/* ===== Scenario 6: 人工锁定不被修改 ===== */

describe('SolverService LOCKED_PERSON 约束', () => {
  it('S6 人工 locked assignment 不会被 Replan 修改（强制指定人员生效）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [
        person({ id: 'p1', load: 0.1 }), // 无锁时更优
        person({ id: 'p2', load: 0.8 }),
      ],
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1' })],
    });

    // 无锁时选中 p1
    const unconstrained = await solver.solve(snapshot, [], {
      ...baseSolveOpts,
      policy: defaultPolicy(),
    });
    expect(unconstrained.assignments[0].personId).toBe('p1');

    // 加 LOCKED_PERSON 后强制 p2
    const constraints: SolverConstraint[] = [
      { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p2' },
    ];
    const locked = await solver.solve(snapshot, constraints, {
      ...baseSolveOpts,
      policy: defaultPolicy(),
    });
    expect(locked.assignments[0].personId).toBe('p2');
  });
});

/* ===== Scenario 7: 执行中任务被冻结 ===== */

describe('SolverService 执行中任务冻结', () => {
  it('S7 普通 Replan 不会移走 executing 任务', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' }), person({ id: 'p2' })],
      tasks: [
        { ...task({ id: 't-exec', status: 'executing' }), assigneeId: 'p1' },
        task({ id: 't-pending' }),
      ],
      devices: [device({ id: 'd1' })],
      lockedAssignments: [
        { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
      ],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    // executing 任务不在新方案中（未被移走）
    expect(plan.assignments.some((a) => a.taskId === 't-exec')).toBe(false);
    // 待办任务仍被安排
    expect(plan.assignments.some((a) => a.taskId === 't-pending')).toBe(true);
  });
});

/* ===== Scenario 8: 旧快照不可审批 ===== */

describe('WorldStateSnapshotService.assertFreshForApprove', () => {
  function makeWorldDb(snapshotRow: unknown, events: unknown[]) {
    const from = jest.fn((table: unknown) => {
      if (table === ewohWorldStateSnapshot) {
        return {
          where: () => ({ limit: () => Promise.resolve(snapshotRow ? [snapshotRow] : []) }),
        };
      }
      if (table === ewohResourceReservation || table === ewohDeviceBinding) {
        const chain: any = Promise.resolve([]);
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return { where: () => chain };
      }
      // P1（2026-08-19 审计）：collectState 事件查询收紧为 status='open'
      // （生产语义），替身同步——按 open 过滤（null 视作 open，与生产
      // status ?? 'open' 缺省口径一致）。
      if (table === ewohEvent) {
        const filtered = events.filter(
          (e) => (e as { status?: string | null }).status == null
            || (e as { status?: string | null }).status === 'open',
        );
        const chain: any = Promise.resolve(filtered);
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return {
          where: () => chain,
        };
      }
      const rows =
        table === ewohPersonnel
          ? []
          : table === ewohDevice
            ? []
            : table === ewohProductionTask
              ? []
              : table === ewohSpatialEntity
                ? []
                : [];
      return Promise.resolve(rows);
    });
    return { db: { select: jest.fn(() => ({ from })) } };
  }

  const snapshotObj: WorldStateSnapshot = {
    snapshotVersion: 'WS-OLD',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [{ eventId: 'e1', severity: 'low', status: 'open', eventType: null }],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };
  const snapshotRow = {
    snapshotVersion: 'WS-OLD',
    snapshotJson: snapshotObj,
    createdAt: new Date(),
  };

  it('S8 基于旧快照的方案无法直接 Approve → 抛出 PLAN_STALE', async () => {
    // 当前世界状态已无 open 事件（与快照指纹不一致 → 过期）
    const { db } = makeWorldDb(snapshotRow, []);
    const svc = new WorldStateSnapshotService(
      db as never,
      { runInTransaction: jest.fn() } as never,
      { projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }) } as never,
    );
    await expect(svc.assertFreshForApprove('WS-OLD')).rejects.toThrow('PLAN_STALE');
  });

  it('快照仍新鲜时审批通过（不抛异常）', async () => {
    // 当前世界状态（空 person/task/device，仅 low open 事件）经 entityVersion
    // 序化得到的 safety 指纹，与快照捕获时刻一致 → 视为新鲜。
    // 性能优化（2026-08-21）：SHA-256 → FNV-1a 48-bit——期望指纹按同一算法计算。
    function fnv1a48(str: string): number {
      let h1 = 0x811c9dc5;
      let h2 = 0x62b821d5;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 ^= c; h1 = Math.imul(h1, 0x01000193);
        h2 ^= c; h2 = Math.imul(h2, 0x01000193);
      }
      // 必须与 world-state.service fnv1a48 保持一致（48-bit = h1 低 16 位作
      // 高位 + h2 全 32 位作低位；旧实现的 2^53 精度丢失/ToInt32 负数截断已修复）。
      const high = (h1 >>> 0) % 0x10000;
      const low = h2 >>> 0;
      return high * 0x100000000 + low;
    }
    const safetyObject = {
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
      forbiddenZones: [],
    };
    const safetyFingerprint = fnv1a48(JSON.stringify(safetyObject));
    const freshSnapshotRow = {
      snapshotVersion: 'WS-OLD',
      snapshotJson: {
        ...snapshotObj,
        entityVersions: { 'risk:safety_block': safetyFingerprint },
      },
      createdAt: new Date(),
    };
    const { db } = makeWorldDb(freshSnapshotRow, [
      { eventId: 'e1', severity: 'low', status: 'open', eventType: null },
    ]);
    const svc = new WorldStateSnapshotService(
      db as never,
      { runInTransaction: jest.fn() } as never,
      { projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }) } as never,
    );
    await expect(svc.assertFreshForApprove('WS-OLD')).resolves.toBeUndefined();
  });
});

/* ===== Scenario 9: Plan A/B/C 不同目标权重 => 不同结果 ===== */

describe('SolverService.solveVariants', () => {
  it('S9 生成 A/B/C 三个方案且权重不同导致结果不同', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [
        person({ id: 'p1', load: 0.7 }),
        person({ id: 'p2', load: 0.0 }),
      ],
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1' })],
    });
    // baseline 把任务锁定给 p1；A 方案对变更代价权重更低，会改为 p2
    const baseline = new Map<string, string | null>([['t1', 'p1']]);

    const plans = await solver.solveVariants(snapshot, [], {
      ...baseSolveOpts,
      baselineAssignee: baseline,
    });

    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.planId)).toEqual(['PA', 'PB', 'PC']);
    expect(plans.map((p) => p.planName)).toEqual(['准时优先', '负荷均衡', '综合平衡']);

    // 三种权重下至少两种产生不同的人员指派
    const personsByPlan = plans.map((p) => p.assignments[0]?.personId);
    expect(new Set(personsByPlan).size).toBeGreaterThan(1);
    // A（准时优先+低变更代价）应改为负荷更低的 p2，而 C（均衡）保留 baseline 的 p1
    expect(plans[0].assignments[0].personId).toBe('p2');
    expect(plans[2].assignments[0].personId).toBe('p1');
  });
});

/* ===== Scenario 10 & 11: 设备离线重排 / 无可行解 ===== */

describe('SolverService 设备离线与无可行解', () => {
  it('S10 当设备离线后 Replan 仍能生成新可行方案（回退到纯手工作业）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' })],
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1', online: false })], // 设备离线
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].deviceId).toBeNull(); // 无在线设备 → 人工完成
    expect(
      plan.violations.some((v) => v.reason === 'no_eligible_resource' && v.taskId === 't1'),
    ).toBe(false);
  });

  it('S11 无可行解时不生成虚假 assignment 并记录 violation', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1', skills: ['welding'] })], // 技能不匹配 taskType=work
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 't1',
          reason: 'no_eligible_resource',
          type: 'infeasible',
        }),
      ]),
    );
  });
});

/* ===== Scenario 12: 结果可解释 ===== */

describe('SolverService 结果可解释性', () => {
  it('S12 每个 assignment 都带有 reasons 与 alternatives 解释字段', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1' })],
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    expect(plan.assignments).toHaveLength(1);
    for (const a of plan.assignments) {
      expect(Array.isArray(a.reasons)).toBe(true);
      expect(Array.isArray(a.alternatives)).toBe(true);
    }
  });

  it('S12 被拒绝的候选资源原因会进入 violation 的解释（alternatives）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1', skills: ['welding'] })],
      tasks: [task({ id: 't1' })],
      devices: [device({ id: 'd1' })],
    });
    const plan = await solver.solve(snapshot, [], { ...baseSolveOpts, policy: defaultPolicy() });

    const violation = plan.violations.find((v) => v.taskId === 't1');
    expect(violation).toBeDefined();
    expect(violation!.alternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasons: expect.arrayContaining(['missing_skill']) }),
      ]),
    );
  });
});

/* ===== Scenario 4: 阻断边不被选中 ===== */

describe('RoutingService A*', () => {
  it('S4 blocked 路由边不会被选中（A* 绕开阻断边）', async () => {
    const nodeRows = [
      { nodeId: 'A', nodeType: 'station', x: 0, y: 0, floor: '1', stationId: 'st1', zoneId: null },
      { nodeId: 'B', nodeType: 'junction', x: 10, y: 0, floor: '1', stationId: null, zoneId: null },
      { nodeId: 'C', nodeType: 'station', x: 5, y: 0, floor: '1', stationId: 'st2', zoneId: null },
    ];
    const edgeRows = [
      { edgeId: 'e1', fromNodeId: 'A', toNodeId: 'B', distanceMeters: 10, expectedTimeSeconds: 10, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
      { edgeId: 'e2', fromNodeId: 'B', toNodeId: 'C', distanceMeters: 5, expectedTimeSeconds: 5, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
      // 直达 A->C 的边被阻断，A* 必须绕行
      { edgeId: 'e3', fromNodeId: 'A', toNodeId: 'C', distanceMeters: 5, expectedTimeSeconds: 5, direction: null, capacity: null, riskLevel: null, status: 'blocked', accessibleFor: [] },
    ];
    const spatialRows = [
      { entityId: 'person-1', x: 0, y: 0 },
      { entityId: 'task-1', x: 5, y: 0 },
    ];
    let spatialIdx = 0;
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          let rows: unknown[] = [];
          if (table === ewohRouteNode) rows = nodeRows;
          else if (table === ewohRouteEdge) rows = edgeRows;
          else if (table === ewohSpatialEntity) {
            // 两次查询按调用顺序返回 person-1 / task-1 各自坐标
            rows = [spatialRows[spatialIdx % spatialRows.length]];
            spatialIdx++;
          }
          // 同时满足 loadGraph 的 await(from) 与 calculateRoute 的 from().where().limit()
          const prom = Promise.resolve(rows) as Promise<unknown[]> & {
            where: jest.Mock;
            limit: jest.Mock;
          };
          prom.where = jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve(rows)),
          }));
          prom.limit = jest.fn(() => Promise.resolve(rows));
          return prom;
        }),
      })),
    };
    const svc = new RoutingService(db as never, {
      getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }),
    } as never);

    const route = await svc.calculateRoute('person-1', 'task-1');

    expect(route.nodes).toEqual(['A', 'B', 'C']);
    expect(route.distanceMeters).toBe(15);
    // 未走被阻断的直达边 A->C
    expect(route.nodes).not.toEqual(['A', 'C']);
  });
});

function defaultPolicy(): SchedulingPolicy {
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
    weights: { lateness: 1, travel: 1, wait: 1, workload: 1, station: 1, change: 1, risk: 1, energy: 1 },
  };
}

/* ===== Phase 0 正确性：重排新鲜快照 + 资源新鲜度（Task A/C/D） ===== */

describe('重排正确性：新鲜快照 + 冻结 executing/locked（Task A/D）', () => {
  it('重排绑定新快照版本，且 executing/locked 任务被冻结不可移动', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      snapshotVersion: 'WS-NEW-0001',
      persons: [person({ id: 'p1' }), person({ id: 'p2' }), person({ id: 'p3' })],
      tasks: [
        { ...task({ id: 't-exec', status: 'executing' }), assigneeId: 'p1' },
        { ...task({ id: 't-locked', status: 'pending' }) },
        task({ id: 't-pending' }),
      ],
      devices: [device({ id: 'd1' })],
      lockedAssignments: [
        { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
        { taskId: 't-locked', personId: 'p2', deviceId: null, stationId: null },
      ],
    });
    const plan = await solver.solve(snapshot, [], {
      ...baseSolveOpts,
      snapshotVersion: snapshot.snapshotVersion,
      policy: defaultPolicy(),
    });
    // 新方案绑定最新快照版本（绝不复用旧快照的 snapshotVersion）
    expect(plan.snapshotVersion).toBe('WS-NEW-0001');
    // executing / locked 任务不被移走
    expect(plan.assignments.some((a) => a.taskId === 't-exec')).toBe(false);
    expect(plan.assignments.some((a) => a.taskId === 't-locked')).toBe(false);
    // 待办任务仍被安排
    expect(plan.assignments.some((a) => a.taskId === 't-pending')).toBe(true);
  });
});

describe('WorldStateSnapshotService.isPlanStale / 资源新鲜度（Task C/D）', () => {
  interface Rows {
    personnel?: unknown[];
    devices?: unknown[];
    tasks?: unknown[];
    routeEdges?: unknown[];
  }

  /** 将 fake db 行数据映射为投影视图（旧直读语义的最小复刻，供 entityVersions 比较）。 */
  function projectionFrom(rows: Rows) {
    return {
      projectForSnapshot: jest.fn().mockResolvedValue({
        persons: (rows.personnel ?? []).map((p) => {
          const row = p as { id: string; status?: string };
          return {
            id: row.id,
            status: row.status ?? 'available',
            healthStatus: 'normal',
            loadLevel: 0,
            fatigueLevel: 0,
            x: null,
            y: null,
            skills: [],
            certifications: [],
            shift: null,
            workload: null,
            currentTaskId: null,
            certificationExpiry: null,
          };
        }),
        devices: (rows.devices ?? []).map((d) => {
          const row = d as { id: string; online?: boolean };
          return {
            id: row.id,
            online: Boolean(row.online),
            status: row.online ? 'online' : 'offline',
            batteryPct: 100,
            capabilities: [],
            x: null,
            y: null,
            locationStationId: null,
            locationConfidence: null,
            telemetryUpdatedAt: null,
            derived: [],
          };
        }),
        stations: [],
      }),
    };
  }

  function makeWorldDb(snapshotRow: unknown, rows: Rows) {
    const from = jest.fn((table: unknown) => {
      if (table === ewohWorldStateSnapshot) {
        return {
          where: () => ({ limit: () => Promise.resolve(snapshotRow ? [snapshotRow] : []) }),
        };
      }
      if (table === ewohResourceReservation || table === ewohDeviceBinding) {
        const chain: any = Promise.resolve([]);
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return { where: () => chain };
      }
      // P1（2026-08-19 审计）：collectState 事件查询收紧为 status='open'
      // （生产语义），替身同步（本双打事件恒空，仅补 where 能力）。
      if (table === ewohEvent) {
        const chain: any = Promise.resolve([]);
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return { where: () => chain };
      }
      const tableRows = new Map<unknown, unknown[]>([
        [ewohPersonnel, rows.personnel ?? []],
        [ewohDevice, rows.devices ?? []],
        [ewohProductionTask, rows.tasks ?? []],
        [ewohRouteEdge, rows.routeEdges ?? []],
        [ewohSpatialEntity, []],
      ]);
      return Promise.resolve(tableRows.get(table) ?? []);
    });
    return { db: { select: jest.fn(() => ({ from })) } };
  }

  async function collectState(rows: Rows): Promise<WorldStateSnapshot> {
    const { db } = makeWorldDb(null, rows);
    const svc = new WorldStateSnapshotService(db as never, {
      runInTransaction: jest.fn(),
    } as never, projectionFrom(rows) as never);
    return (await (
      svc as unknown as { collectState(): Promise<WorldStateSnapshot> }
    ).collectState()) as WorldStateSnapshot;
  }

  const personRow = (id: string, status: string) => ({
    id, name: id, status, skills: ['work'], updatedAt: new Date(),
  });
  const deviceRow = (id: string, online: boolean) => ({
    id, online, batteryPct: 100, lastTelemetryAt: new Date(), updatedAt: new Date(),
  });
  const taskRow = (id: string, status: string) => ({
    id, title: id, taskType: 'work', priority: 'medium', status,
    assigneeId: null, deviceId: null, spatialEntityId: null,
    planStart: null, planEnd: null, progress: 0,
    predecessorIds: [], requiredSkills: ['work'], requiredCertifications: [],
  });
  const routeRow = (edgeId: string, status: string) => ({
    edgeId, status, riskLevel: null,
  });

  async function assertBecomesStale(before: Rows, after: Rows): Promise<void> {
    const state = await collectState(before);
    const oldSnapshot: WorldStateSnapshot = {
      ...state,
      snapshotVersion: 'WS-P',
      ts: new Date().toISOString(),
    };
    const snapshotRow = { snapshotVersion: 'WS-P', snapshotJson: oldSnapshot, createdAt: new Date() };
    const { db } = makeWorldDb(snapshotRow, after);
    const svc = new WorldStateSnapshotService(db as never, {
      runInTransaction: jest.fn(),
    } as never, projectionFrom(after) as never);
    expect(await svc.isPlanStale('WS-P')).toBe(true);
  }

  it('人员状态变更 → 旧方案变 stale（isPlanStale=true）', async () => {
    await assertBecomesStale(
      { personnel: [personRow('p1', 'available')] },
      { personnel: [personRow('p1', 'unavailable')] },
    );
  });

  it('设备在线状态变更 → 旧方案变 stale', async () => {
    await assertBecomesStale(
      { devices: [deviceRow('d1', true)] },
      { devices: [deviceRow('d1', false)] },
    );
  });

  it('任务状态变更 → 旧方案变 stale', async () => {
    await assertBecomesStale(
      { tasks: [taskRow('t1', 'pending')] },
      { tasks: [taskRow('t1', 'executing')] },
    );
  });

  it('路线状态变更 → 旧方案变 stale', async () => {
    await assertBecomesStale(
      { routeEdges: [routeRow('e1', 'open')] },
      { routeEdges: [routeRow('e1', 'closed')] },
    );
  });

  it('世界状态未变化 → 方案保持新鲜（不 stale）', async () => {
    const state = await collectState({ personnel: [personRow('p1', 'available')] });
    const oldSnapshot: WorldStateSnapshot = {
      ...state,
      snapshotVersion: 'WS-P',
      ts: new Date().toISOString(),
    };
    const snapshotRow = { snapshotVersion: 'WS-P', snapshotJson: oldSnapshot, createdAt: new Date() };
    const { db } = makeWorldDb(snapshotRow, { personnel: [personRow('p1', 'available')] });
    const svc = new WorldStateSnapshotService(db as never, {
      runInTransaction: jest.fn(),
    } as never, projectionFrom({ personnel: [personRow('p1', 'available')] }) as never);
    expect(await svc.isPlanStale('WS-P')).toBe(false);
  });

  it('STALE 数据的人员/设备不被视为可用（不可调度）', async () => {
    const { db } = makeWorldDb(null, {
      personnel: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', updatedAt: new Date(Date.now() - 10_000) }],
      devices: [{ id: 'd1', online: true, batteryPct: 100, lastTelemetryAt: new Date(Date.now() - 10_000), updatedAt: new Date() }],
    });
    // 新鲜度判定已迁至 ResourceProjectionService；此处注入其 STALE 输出（mock 模拟投影结果）。
    const svc = new WorldStateSnapshotService(db as never, { runInTransaction: jest.fn() } as never, {
      projectForSnapshot: jest.fn().mockResolvedValue({
        persons: [{
          id: 'p1', name: 'p1', status: 'UNKNOWN', healthStatus: 'normal',
          loadLevel: 0, fatigueLevel: 0, x: null, y: null, skills: [], certifications: [],
          shift: null, workload: null, currentTaskId: null, certificationExpiry: null,
          sourceTs: Date.now() - 10_000, freshnessMs: 1000, dataQuality: 'STALE',
        }],
        devices: [{
          id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, capabilities: [],
          online: false, status: 'OFFLINE', x: null, y: null, locationStationId: null,
          availableWindows: [], locationConfidence: null, locationUpdatedAt: null,
          telemetryUpdatedAt: null, sourceTs: Date.now() - 10_000, freshnessMs: 1000,
          dataQuality: 'STALE', derived: [],
        }],
        stations: [],
      }),
    } as never);
    const state = (await (svc as unknown as { collectState(): Promise<WorldStateSnapshot> }).collectState()) as WorldStateSnapshot;
    expect(state.persons[0].dataQuality).toBe('STALE');
    expect(state.persons[0].status).toBe('UNKNOWN');
    expect(state.devices[0].dataQuality).toBe('STALE');
    expect(state.devices[0].online).toBe(false);
  });

  it('UNKNOWN（无时间戳）数据的人员不被视为可用', async () => {
    const { db } = makeWorldDb(null, {
      personnel: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', updatedAt: null }],
    });
    // 新鲜度判定已迁至 ResourceProjectionService；此处注入其 UNKNOWN 输出（mock 模拟投影结果）。
    const svc = new WorldStateSnapshotService(db as never, { runInTransaction: jest.fn() } as never, {
      projectForSnapshot: jest.fn().mockResolvedValue({
        persons: [{
          id: 'p1', name: 'p1', status: 'UNKNOWN', healthStatus: 'normal',
          loadLevel: 0, fatigueLevel: 0, x: null, y: null, skills: [], certifications: [],
          shift: null, workload: null, currentTaskId: null, certificationExpiry: null,
          sourceTs: null, freshnessMs: 300000, dataQuality: 'UNKNOWN',
        }],
        devices: [],
        stations: [],
      }),
    } as never);
    const state = (await (svc as unknown as { collectState(): Promise<WorldStateSnapshot> }).collectState()) as WorldStateSnapshot;
    expect(state.persons[0].dataQuality).toBe('UNKNOWN');
    expect(state.persons[0].status).toBe('UNKNOWN');
  });
});

/* ===== NO-62c：方案过期可解释（describeStaleness / explainPlanStaleness 共用内核） ===== */

describe('WorldStateSnapshotService.describeStaleness（NO-62c）', () => {
  const baseSnapshot: WorldStateSnapshot = {
    snapshotVersion: 'WS-1',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: { 'task:T-1': 111, 'device:AGV-1': 222, 'reservation:person:P-1': 333 },
    reservations: [
      { reservationId: 'RS-1', resourceType: 'person', resourceId: 'P-1', startMs: 0, endMs: 1000 },
    ],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };

  function makeDb(options: {
    snapshot?: WorldStateSnapshot | null;
    dispatchedTaskIds?: string[];
    ownReservations?: Array<{ resourceType: string; resourceId: string }>;
  }) {
    const from = jest.fn((table: unknown) => {
      if (table === ewohWorldStateSnapshot) {
        return {
          where: () => ({
            limit: () =>
              Promise.resolve(
                options.snapshot
                  ? [{ snapshotVersion: 'WS-1', snapshotJson: options.snapshot, orgId: 'ORG-1' }]
                  : [],
              ),
          }),
        };
      }
      if (table === ewohSchedulingPlanAssignment) {
        const chain: any = Promise.resolve(
          (options.dispatchedTaskIds ?? []).map((taskId) => ({ taskId })),
        );
        chain.where = () => chain;
        return { where: () => chain };
      }
      if (table === ewohResourceReservation || table === ewohDeviceBinding) {
        const chain: any = Promise.resolve(options.ownReservations ?? []);
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return { where: () => chain };
      }
      const chain: any = Promise.resolve([]);
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      return { where: () => chain };
    });
    return { db: { select: jest.fn(() => ({ from })) } };
  }

  function makeService(db: unknown, currentOverride?: unknown) {
    const service = new WorldStateSnapshotService(
      db as never,
      { runInTransaction: jest.fn() } as never,
      {
        projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
      } as never,
    );
    // NO-64a：审批闸门内部会 `collectState` 取当前世界；测试里用显式"当前状态"替换它，
    // 这样"证据老化/内容变化"的场景是**确定性**的（不依赖真实时钟与库内容）。
    if (currentOverride) {
      jest
        .spyOn(service as never, 'collectState' as never)
        .mockResolvedValue(currentOverride as never);
    }
    return service;
  }

  it('快照存在差异 → stale + 逐项差异（实体类型/id 拆解 + 人话标签）', async () => {
    // 当前世界状态：task 版本变了、device 消失、预占释放
    const current = {
      ...baseSnapshot,
      entityVersions: { 'task:T-1': 999, 'reservation:person:P-1': 333 },
      reservations: [
        { reservationId: 'RS-1', resourceType: 'person', resourceId: 'P-1', startMs: 0, endMs: 1000 },
      ],
    };
    const svc = makeService(makeDb({ snapshot: baseSnapshot }).db);
    const report = await svc.describeStaleness('WS-1', undefined, current as never);

    expect(report.stale).toBe(true);
    expect(report.snapshotFound).toBe(true);
    const task = report.changes.find((c) => c.entityKey === 'task:T-1');
    expect(task).toMatchObject({ entityType: 'task', entityId: 'T-1', change: 'changed', before: 111, after: 999 });
    expect(task?.label).toContain('版本 111 → 999');
    const device = report.changes.find((c) => c.entityKey === 'device:AGV-1');
    expect(device).toMatchObject({ entityType: 'device', entityId: 'AGV-1', change: 'removed', after: null });
    expect(report.summary).toContain('外部变化');
  });

  it('无差异 → 不 stale（不制造"过期"焦虑）', async () => {
    const svc = makeService(makeDb({ snapshot: baseSnapshot }).db);
    const report = await svc.describeStaleness('WS-1', undefined, baseSnapshot as never);
    expect(report.stale).toBe(false);
    expect(report.changes).toEqual([]);
    expect(report.summary).toBe('世界状态与方案生成时一致');
  });

  it('本方案自身已派工/已建预占的变化标 selfInflicted（不把"我刚派的第一波"当成外部干扰）', async () => {
    const snapshotWithSelf: WorldStateSnapshot = {
      ...baseSnapshot,
      entityVersions: { 'task:T-1': 111, 'reservation:person:P-1': 333 },
      reservations: [],
    };
    const current = {
      ...snapshotWithSelf,
      entityVersions: { 'task:T-1': 500, 'reservation:person:P-1': 333 },
      reservations: [
        { reservationId: 'RS-2', resourceType: 'person', resourceId: 'P-1', startMs: 0, endMs: 50 },
      ],
    };
    const svc = makeService(
      makeDb({
        snapshot: snapshotWithSelf,
        dispatchedTaskIds: ['T-1'],
        ownReservations: [{ resourceType: 'person', resourceId: 'P-1' }],
      }).db,
    );
    const report = await svc.describeStaleness('WS-1', undefined, current as never, 'PLAN-1');

    expect(report.stale).toBe(true);
    expect(report.selfInflictedCount).toBe(report.changes.length);
    expect(report.externalChangeCount).toBe(0);
    expect(report.summary).toContain('仅本方案自身的执行效果变化');
  });

  /**
   * FR-01（V67 全链重放抓到，登记见基线文档 §5.4）：设备**证据老化**不得改写内容版本。
   *
   * 为什么这条值得存在：本文件顶部（world-state.service.ts:545-547）写着一条不变量——
   * "内容版本排除了随时间自然变化的派生字段（设备 status/online、过期后的状态标签），
   * 所以'只是过了 60 秒'不再被误判为世界变化"。**实测这条不成立**：
   *  - `freshnessAwareStatus`（:1283-1286）在 `dataQuality !== 'FRESH'` 时返回哨兵串，哨兵本身随时钟翻转；
   *  - 而投影里的 `status` 本来就已经是新鲜度派生（resource-projection.service.ts:337-343：
   *    设备无权威 status 列，状态=faultCode ∧ 新鲜度；:231-233 人员过期即 UNKNOWN），
   *    所以"掩盖"与否都改变同一列。
   * 后果：`stalenessVerdict` 把任何内容版本差异一律算 `contentChanged`（**不看方案是否依赖该实体**，
   * 只有"证据档"才按 `used` 分流）⇒ 任意一台设备跨过 60s 新鲜度边界，就把**所有**在批方案一起判过期。
   * 实测现场：`e2e:fault-replan` 的 ⑥ 审批 409 PLAN_STALE，变化实体恰为 `device:*[content/external]`，
   * 而方案行仍是 `shadow`、`supersededBy=-`（没有任何真实改动、也没有别处重排）。
   *
   * 为什么既有 NO-64a 用例没抓到：它们是**手喂** `entityContentVersions` 来比对判定逻辑的，
   * 从不经过这道计算口——"设备沉默但方案不依赖它 → 不阻断审批"那条用例的名称正是本条要求，
   * 却在合成边界处把它绕开了。
   *
   * **用例性质：现状钉住**（与 RJ-02/RJ-03、S-05 同一族）。为什么不用 `it.fails`/skip：
   * skip 会让缺陷从可见面消失（本轮刚给链级 D 段装上"SKIP 不算通过"的门禁），
   * 而钉住现状能把"今天确实如此"变成可重放的证据。
   * **已选定的修法（V69）= 判定侧分流**（`stalenessVerdict` 里把"可由新鲜度迁移完全解释"的内容差异
   * 改判到按 `used` 分流的证据通道），因此**这道计算口的现状不变**：本用例继续钉住"内容版本随时钟翻转"这一事实，
   * 它是那条分流规则存在理由的永久证据（一旦有人把权威值透出到投影、让内容版本不再随时钟变，
   * 本用例就会变红——那时把它翻成 `.toBe` 并删掉判定侧的分流分支即可）。
   * 端到端的验收在下一条用例（`NO-64a + FR-01：…`，走真实计算口 + 真实判定）。
   */
  it('FR-01 现状钉住：设备证据老化会改写内容版本（判定侧据此分流，故保留此事实）', async () => {
    const deviceOf = (quality: 'FRESH' | 'STALE', status = 'AVAILABLE') => ({
      id: 'DA-1',
      entityId: 'device:DA-1',
      status,
      // online 与心跳同源：真实投影里"过期即 false"，因此这里同样随时钟翻
      online: quality === 'FRESH',
      batteryPct: 80,
      capabilities: ['LIFT'],
      x: 1,
      y: 2,
      locationStationId: 'ST-1',
      locationConfidence: 'HIGH',
      dataQuality: quality,
      sourceTs: 1_000,
      telemetryUpdatedAt: quality === 'FRESH' ? 1_000 : 9_000_000,
    });
    const contentVersionOf = async (device: Record<string, unknown>) => {
      const service = new WorldStateSnapshotService(
        makeApprovalDb({ snapshot: null }).db as never,
        { runInTransaction: jest.fn() } as never,
        {
          projectForSnapshot: jest
            .fn()
            .mockResolvedValue({ persons: [], devices: [device], stations: [] }),
        } as never,
      );
      const state = await service.getCurrentWorldState({ primaryOrgId: 'ORG-1' } as never);
      return (state as { entityContentVersions: Record<string, number> })
        .entityContentVersions['device:DA-1'];
    };

    // 现状（缺陷）：同一权威列、只是心跳过期 ⇒ 内容版本**竟然不同**。
    // 修复后这一条必须翻成 .toBe（见上方用例性质）。
    expect(await contentVersionOf(deviceOf('STALE'))).not.toBe(await contentVersionOf(deviceOf('FRESH')));
    // 权威列真的变了（人工停用）⇒ 内容版本必须不同：修法不许把这条一起削弱
    expect(await contentVersionOf(deviceOf('FRESH', 'UNAVAILABLE')))
      .not.toBe(await contentVersionOf(deviceOf('FRESH')));
  });

  /* ── NO-64a：事实变化 vs 证据老化（审批/派工共用同一判定） ── */

  /**
   * FR-01 修复的验收（走**真实计算口**，不手喂内容版本）：
   * 快照与"当前状态"都由 `getCurrentWorldState` 真算出来，只差设备心跳是否过期。
   * 这是这道缺陷能被抓到的唯一形状——上面那批 NO-64a 用例直接喂 `entityContentVersions`，
   * 恰好绕开了"内容版本随时钟翻转"这一步。
   */
  async function agedDevicePair() {
    const deviceOf = (quality: 'FRESH' | 'STALE') => ({
      id: 'DA-1',
      entityId: 'device:DA-1',
      status: 'AVAILABLE',
      online: quality === 'FRESH',
      batteryPct: 80,
      capabilities: ['LIFT'],
      x: 1,
      y: 2,
      locationStationId: 'ST-1',
      locationConfidence: 'HIGH',
      dataQuality: quality,
      sourceTs: 1_000,
      telemetryUpdatedAt: quality === 'FRESH' ? 1_000 : 9_000_000,
    });
    const collect = async (quality: 'FRESH' | 'STALE') => {
      const service = new WorldStateSnapshotService(
        makeApprovalDb({ snapshot: null }).db as never,
        { runInTransaction: jest.fn() } as never,
        {
          projectForSnapshot: jest.fn().mockResolvedValue({
            persons: [], devices: [deviceOf(quality)], stations: [],
          }),
        } as never,
      );
      return await service.getCurrentWorldState({ primaryOrgId: 'ORG-1' } as never);
    };
    return { fresh: await collect('FRESH'), stale: await collect('STALE') };
  }

  it('NO-64a + FR-01：设备只是心跳过期 ⇒ 不阻断"不依赖它"的审批；依赖它则按 EVIDENCE_STALE 拒绝', async () => {
    const { fresh, stale } = await agedDevicePair();
    // 前提（本用例成立的条件）：真实计算口确实让内容版本随时钟变了——这正是 FR-01 的成因。
    expect(
      (stale as { entityContentVersions: Record<string, number> }).entityContentVersions['device:DA-1'],
    ).not.toBe(
      (fresh as { entityContentVersions: Record<string, number> }).entityContentVersions['device:DA-1'],
    );

    // 依赖关系沿用既有 NO-64a 用例的形状（由 assignment 行喂进来），不去 spy 私有方法。
    const makeSvc = (deviceIdOfAssignment: string | null) => makeService(
      makeApprovalDb({
        snapshot: fresh as never,
        assignments: deviceIdOfAssignment
          ? [{ taskId: 'T-9', personId: 'P-1', deviceId: deviceIdOfAssignment, stationId: 'S-1' }]
          : [],
        reservations: [],
      }).db,
      stale,
    );
    const ctx = { primaryOrgId: 'ORG-1' } as never;

    // ① 方案不依赖这台设备：老化不是世界变化 ⇒ 审批必须放行
    await expect(
      makeSvc(null).assertFreshForApprove('WS-1', ctx, 'PLAN-1'),
    ).resolves.toBeUndefined();

    // ② 方案依赖这台设备：仍然必须拒绝，但原因要是 EVIDENCE_STALE（不再冒充"内容变了"）
    await expect(
      makeSvc('DA-1').assertFreshForApprove('WS-1', ctx, 'PLAN-1'),
    ).rejects.toThrow(/PLAN_STALE:EVIDENCE_STALE/);
  });

  function makeApprovalDb(options: {
    snapshot: WorldStateSnapshot | null;
    assignments?: Array<Record<string, unknown>>;
    reservations?: Array<Record<string, unknown>>;
  }) {
    const from = jest.fn((table: unknown) => {
      if (table === ewohWorldStateSnapshot) {
        return {
          where: () => ({
            limit: () =>
              Promise.resolve(
                options.snapshot
                  ? [{ snapshotVersion: 'WS-1', snapshotJson: options.snapshot, orgId: 'ORG-1' }]
                  : [],
              ),
          }),
        };
      }
      if (table === ewohSchedulingPlanAssignment) {
        const chain: any = Promise.resolve(options.assignments ?? []);
        chain.where = () => chain;
        return { where: () => chain };
      }
      if (table === ewohResourceReservation || table === ewohDeviceBinding) {
        const chain: any = Promise.resolve(options.reservations ?? []);
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        return { where: () => chain };
      }
      const chain: any = Promise.resolve([]);
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      return { where: () => chain };
    });
    return { db: { select: jest.fn(() => ({ from })) } };
  }

  /** 构造一份"设备 DA-1（版本 A，内容 A）+ 任务 T-9"的快照与当前状态。 */
  function ageScenario(options: {
    deviceStatusBefore: string;
    deviceStatusAfter: string;
    dataQualityAfter: 'FRESH' | 'STALE' | 'UNKNOWN';
    evidenceChanged: boolean;
    contentChanged?: boolean;
  }) {
    const before: WorldStateSnapshot = {
      ...baseSnapshot,
      entityVersions: { 'device:DA-1': 100, 'task:T-9': 200 },
      entityContentVersions: { 'device:DA-1': 1000, 'task:T-9': 2000 },
      entityEvidence: {
        'device:DA-1': { sourceTs: 1_000, dataQuality: 'FRESH', status: options.deviceStatusBefore },
      },
      devices: [],
      tasks: [],
      reservations: [],
    };
    const after = {
      ...before,
      entityVersions: {
        'device:DA-1': options.evidenceChanged ? 101 : 100,
        'task:T-9': 200,
      },
      entityContentVersions: {
        'device:DA-1': options.contentChanged ? 9999 : 1000,
        'task:T-9': 2000,
      },
      entityEvidence: {
        'device:DA-1': {
          sourceTs: 2_000,
          dataQuality: options.dataQualityAfter,
          status: options.deviceStatusAfter,
        },
      },
    };
    return { before, after };
  }

  it('NO-64a 心跳/沉默：内容未变 → 不判过期（只是证据时钟推进）', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'AVAILABLE',
      dataQualityAfter: 'FRESH',
      evidenceChanged: true,
      contentChanged: false,
    });
    const svc = makeService(
      makeApprovalDb({
        snapshot: before,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-1', stationId: 'S-1' }],
      }).db,
      after,
    );
    await expect(svc.assertFreshForApprove('WS-1', undefined, 'PLAN-1')).resolves.toBeUndefined();
  });

  it('NO-64a 设备沉默且方案**依赖**它 → 拒绝，原因 EVIDENCE_STALE（不拿过期证据背书）', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'OFFLINE',
      dataQualityAfter: 'STALE',
      evidenceChanged: true,
      contentChanged: false,
    });
    const svc = makeService(
      makeApprovalDb({
        snapshot: before,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-1', stationId: 'S-1' }],
      }).db,
      after,
    );
    await expect(svc.assertFreshForApprove('WS-1', undefined, 'PLAN-1'))
      .rejects.toThrow('PLAN_STALE:EVIDENCE_STALE');
  });

  it('NO-64a 设备沉默但方案**不依赖**它 → 不阻断审批（与本方案无关的沉默不是世界变化）', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'OFFLINE',
      dataQualityAfter: 'STALE',
      evidenceChanged: true,
      contentChanged: false,
    });
    const svc = makeService(
      makeApprovalDb({
        snapshot: before,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-999', stationId: 'S-1' }],
      }).db,
      after,
    );
    await expect(svc.assertFreshForApprove('WS-1', undefined, 'PLAN-1')).resolves.toBeUndefined();
  });

  it('NO-64a 内容真的变了（哪怕设备仍然新鲜）→ 拒绝，原因 CONTENT_CHANGED', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'AVAILABLE',
      dataQualityAfter: 'FRESH',
      evidenceChanged: true,
      contentChanged: true,
    });
    const svc = makeService(
      makeApprovalDb({
        snapshot: before,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-1', stationId: 'S-1' }],
      }).db,
      after,
    );
    await expect(svc.assertFreshForApprove('WS-1', undefined, 'PLAN-1'))
      .rejects.toThrow('PLAN_STALE:CONTENT_CHANGED');
  });

  it('NO-64a 老快照没有内容版本 → 一律严格判定（fail-closed，不静默放宽）', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'OFFLINE',
      dataQualityAfter: 'STALE',
      evidenceChanged: true,
      contentChanged: false,
    });
    const legacy = { ...before, entityContentVersions: undefined };
    const svc = makeService(
      makeApprovalDb({
        snapshot: legacy,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-1', stationId: 'S-1' }],
      }).db,
      after,
    );
    await expect(svc.assertFreshForApprove('WS-1', undefined, 'PLAN-1'))
      .rejects.toThrow('PLAN_STALE');
  });

  it('NO-64a 诊断分档：事实变化 / 依赖资源证据过期 / 仅证据老化 三档可区分', async () => {
    const { before, after } = ageScenario({
      deviceStatusBefore: 'AVAILABLE',
      deviceStatusAfter: 'OFFLINE',
      dataQualityAfter: 'STALE',
      evidenceChanged: true,
      contentChanged: false,
    });
    const svc = makeService(
      makeApprovalDb({
        snapshot: before,
        assignments: [{ taskId: 'T-9', personId: 'P-1', deviceId: 'DA-1', stationId: 'S-1' }],
      }).db,
      after,
    );
    const report = await svc.describeStaleness('WS-1', undefined, after as never, 'PLAN-1');
    const device = report.changes.find((c) => c.entityKey === 'device:DA-1');
    expect(device?.severity).toBe('blocked_evidence');
    expect(device?.usedByPlan).toBe(true);
    expect(report.stale).toBe(true);
    expect(report.reason).toBe('EVIDENCE_STALE');
    expect(report.blockedEvidenceCount).toBe(1);
    expect(report.summary).toContain('方案依赖的资源证据已过期');
  });

  it('快照行已不存在 → 显式说明"无法判断差异"（不假装新鲜）', async () => {
    const svc = makeService(makeDb({ snapshot: null }).db);
    const report = await svc.describeStaleness('WS-GONE');
    expect(report.snapshotFound).toBe(false);
    expect(report.stale).toBe(true);
    expect(report.summary).toContain('找不到方案绑定的世界快照');
  });
});
