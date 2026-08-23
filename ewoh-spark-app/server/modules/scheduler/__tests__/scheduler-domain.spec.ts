import { createHash } from 'node:crypto';
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
    // NEST-149（2026-08-17）：entityVersion 哈希 djb2 → SHA-256 48-bit 折叠——
    // 期望指纹按同一算法计算（非硬编码常量，防算法再漂移时假绿）。
    const safetyObject = {
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
      forbiddenZones: [],
    };
    const safetyFingerprint = parseInt(
      createHash('sha256')
        .update(JSON.stringify(safetyObject))
        .digest('hex')
        .slice(0, 12),
      16,
    );
    const freshSnapshotRow = {
      snapshotVersion: 'WS-OLD',
      snapshotJson: {
        ...snapshotObj,
        entityVersions: { safety: safetyFingerprint },
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