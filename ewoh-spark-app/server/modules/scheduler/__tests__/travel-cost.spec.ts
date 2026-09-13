/* Phase 2 / P2-T1：TravelCostService RouteCostMatrix 测试。
 *
 * 覆盖：buildMatrix 逐候选聚合（route_graph / coords_unknown / no_route_edge）、
 * forbiddenZone / blocked 矩阵层显式标记、feasible 语义、缓存读写（决策 D-D）。
 */
/// <reference types="jest" />
import { TravelCostService, candidateSetHash } from '../travel-cost.service';
import { ewohRouteCostMatrix } from '@server/database/schema';
import type { RouteCostMatrix, WorldStateSnapshot } from '@shared/api.interface';

const HOUR = 3600_000;

/**
 * 内存态 fake db（支持 select().from().where().limit() 与 insert/update）。
 * NEST-161（2026-08-17）：persistMatrix 改为 INSERT ... ON CONFLICT
 * (task_id, snapshot_version) DO UPDATE 原子 upsert——insert 链补
 * onConflictDoUpdate（同键幂等覆盖，不新增行），与真实唯一索引语义一致。
 */
function makeFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const conflictKey = (r: Record<string, unknown>) =>
    `${r.taskId}::${r.snapshotVersion}`;
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== ewohRouteCostMatrix) return Promise.resolve([]);
        return {
          where: () => ({
            limit: () => Promise.resolve(rows.slice(0, 1)),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        const row = { ...(values as Record<string, unknown>) };
        const key = conflictKey(row);
        const existingIdx = rows.findIndex((r) => conflictKey(r) === key);
        const applyUpsert = (): Record<string, unknown> => {
          if (existingIdx >= 0) {
            // NEST-161：同 (task, snapshot) 键 → 幂等覆盖（不新增行）。
            rows[existingIdx] = { ...rows[existingIdx], ...row };
            return rows[existingIdx];
          }
          rows.push(row);
          return row;
        };
        return {
          // thenable + returning 双形态（drizzle 无 returning 时直接 await 执行）。
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([applyUpsert()]),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(applyUpsert()).then(resolve),
          }),
          returning: () => {
            rows.push(row);
            return Promise.resolve([row]);
          },
        };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => Promise.resolve([patch]),
      }),
    }),
  };
  return { db, rows };
}

function makeSvc(
  routingOverrides: Partial<Record<'calculateRouteBetween' | 'calculateRoute', jest.Mock>>,
) {
  const { db, rows } = makeFakeDb();
  const routing = {
    calculateRouteBetween: jest.fn(),
    calculateRoute: jest.fn(),
    ...routingOverrides,
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue({
      version: 1,
      solverVersion: 'heuristic-v2',
      weights: { lateness: 3, travel: 1, wait: 1, workload: 1, station: 1, change: 0.5, risk: 1, energy: 0.5 },
    }),
    getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1 }),
  };
  const svc = new TravelCostService(db, routing as never, policy as never);
  return { svc, routing, policy, rows };
}

function baseSnapshot(over: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-MATRIX-0001',
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
    ...over,
  };
}

const TASK = {
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
} as WorldStateSnapshot['tasks'][number];

describe('P2-T1: TravelCostService / RouteCostMatrix', () => {
  it('buildMatrix 聚合候选：route_graph 候选 feasible=true / fallbackReason=null / dataQuality=FRESH', async () => {
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'ROUTE-1', distanceMeters: 15, etaSeconds: 15, nodes: ['A', 'B'],
        geometry: [], source: 'route_graph', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
      }),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    expect(matrix.matrixId).toContain('RCM-');
    expect(matrix.snapshotVersion).toBe('WS-MATRIX-0001');
    expect(matrix.taskId).toBe('t1');
    expect(matrix.candidates).toHaveLength(1);
    const c = matrix.candidates[0];
    expect(c.personId).toBe('p1');
    expect(c.feasible).toBe(true);
    expect(c.routeCostMode).toBe('route_graph');
    expect(c.fallbackReason).toBeNull();
    expect(c.dataQuality).toBe('FRESH');
    expect(c.etaSeconds).toBe(15);
    expect(c.forbiddenZone).toBe(false);
    expect(c.blocked).toBe(false);
  });

  it('坐标未知候选 → dataQuality=UNKNOWN / fallbackReason=coords_unknown / feasible=false（绝不 0,0）', async () => {
    const { svc, routing } = makeSvc({
      calculateRoute: jest.fn().mockResolvedValue({
        routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
        source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'coords_unknown', dataQuality: 'UNKNOWN',
      }),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p-unknown', name: 'p-unknown', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: null, y: null }],
      stations: [],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p-unknown', deviceId: null, stationId: null },
    ]);
    const c = matrix.candidates[0];
    expect(c.feasible).toBe(false);
    expect(c.fallbackReason).toBe('coords_unknown');
    expect(c.dataQuality).toBe('UNKNOWN');
  });

  it('任务位于禁入区 → forbiddenZone=true 且 feasible=false', async () => {
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'ROUTE-1', distanceMeters: 15, etaSeconds: 15, nodes: ['A', 'B'], geometry: [],
        source: 'route_graph', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
      }),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z-FORBIDDEN', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
      forbiddenZones: [{ zoneId: 'Z-FORBIDDEN', reason: 'restricted_zone' }],
    });
    const task = { ...TASK, zoneId: 'Z-FORBIDDEN' };
    const matrix = await svc.buildMatrix(snapshot, task, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    const c = matrix.candidates[0];
    expect(c.forbiddenZone).toBe(true);
    expect(c.feasible).toBe(false);
  });

  it('routeStatus 含 blocked 边 + 候选走 euclidean 兜底 → blocked=true 且 feasible=false（P0 硬约束：阻断即不可行）', async () => {
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
        source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'no_route_edge', dataQuality: 'FRESH',
      }),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
      routeStatus: [{ edgeId: 'e1', status: 'blocked', riskLevel: null }],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    const c = matrix.candidates[0];
    expect(c.blocked).toBe(true);
    // P0 硬约束语义：blocked 路线不可达即不可行（feasible=false），
    // 阻断候选不得作为可用成本估算送入求解器。
    expect(c.feasible).toBe(false);
  });

  it('缺 org 上下文 → 跳过缓存写（不落 system 哨兵、不污染主事务；2026-09-13 回归）', async () => {
    const insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
      })),
    }));
    const db = { insert } as never;
    const svc2 = new TravelCostService(
      db as never,
      { getActivePolicy: jest.fn(), getConfig: jest.fn() } as never,
      {} as never,
    );
    // matrix 为最小形状——缺 org 时服务层在触碰 db 前即返回，形状仅需可引用。
    const minimalMatrix = {
      matrixId: 'RCM-X', taskId: 't-x', snapshotVersion: 'WS-X', policyVersion: 1,
      solverVersion: 'heuristic-v2', routeGraphVersion: null, candidateSetHash: null,
      candidates: [], generatedAt: new Date().toISOString(),
    } as never;
    await svc2.persistMatrix(minimalMatrix, null);
    await svc2.persistMatrix(minimalMatrix, '');
    expect(insert).not.toHaveBeenCalled();
  });

  it('决策 D-D：矩阵落库缓存（persistMatrix 写、getCachedMatrix 读、同键幂等覆盖）', async () => {
    const { svc, rows } = makeSvc({ calculateRouteBetween: jest.fn() });
    const cand = { personId: 'p1', deviceId: null, stationId: 'S1' };
    const hash = candidateSetHash([cand]);
    const matrix: RouteCostMatrix = {
      matrixId: `RCM-1-${hash}-1-t1`,
      snapshotVersion: 'WS-MATRIX-0001',
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
      routeGraphVersion: 1,
      candidateSetHash: hash,
      taskId: 't1',
      candidates: [
        {
          personId: 'p1', deviceId: null, stationId: 'S1', etaSeconds: 10, distanceMeters: 10,
          congestion: 1, blocked: false, forbiddenZone: false, risk: 1, energy: 0,
          routeCostMode: 'euclidean_fallback', fallbackReason: 'no_route_edge', dataQuality: 'FRESH', feasible: true,
        },
      ],
      generatedAt: new Date().toISOString(),
    };
    await svc.persistMatrix(matrix, 'org-1');
    expect(rows).toHaveLength(1);

    const cached = await svc.getCachedMatrix('t1', 'WS-MATRIX-0001', 1, '1', hash);
    expect(cached).not.toBeNull();
    expect(cached!.taskId).toBe('t1');
    expect(cached!.candidates[0].personId).toBe('p1');
    expect(cached!.candidates[0].feasible).toBe(true);

    // 幂等覆盖：再次写不新增行。
    await svc.persistMatrix(matrix, 'org-1');
    expect(rows).toHaveLength(1);
  });

  it('Task 4：不同 policyVersion → 不复用缓存矩阵（重新计算）', async () => {
    const routeOk = {
      routeId: 'R', distanceMeters: 15, etaSeconds: 15, nodes: ['A', 'B'], geometry: [],
      source: 'route_graph', riskLevel: null, graphVersion: null,
      calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
    };
    const { svc, routing, policy, rows } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue(routeOk),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const candidates = [{ personId: 'p1', deviceId: 'd1', stationId: 'S1' }];
    await svc.buildMatrix(snapshot, TASK, candidates, 'org-1');
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(1);

    // 切换策略版本（同 snapshot/task/candidates）→ 不应复用缓存，应重新计算。
    policy.getActivePolicy.mockResolvedValue({
      version: 2, solverVersion: 'heuristic-v3',
      weights: { lateness: 3, travel: 1, wait: 1, workload: 1, station: 1, change: 0.5, risk: 1, energy: 0.5 },
    });
    const matrix2 = await svc.buildMatrix(snapshot, TASK, candidates, 'org-1');
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(2);
    expect(matrix2.policyVersion).toBe(2);
    expect(matrix2.candidateSetHash).toBe(candidateSetHash(candidates));
    expect(rows).toHaveLength(1); // 同 (task, snapshot) 唯一键 → 幂等覆盖
  });

  it('Task 4：不同 candidateSetHash → 不复用缓存矩阵（重新计算）', async () => {
    const routeOk = {
      routeId: 'R', distanceMeters: 15, etaSeconds: 15, nodes: ['A', 'B'], geometry: [],
      source: 'route_graph', riskLevel: null, graphVersion: null,
      calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
    };
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue(routeOk),
    });
    const snapshot = baseSnapshot({
      persons: [
        { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
        { id: 'p2', name: 'p2', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
      ],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    await svc.buildMatrix(snapshot, TASK, [{ personId: 'p1', deviceId: 'd1', stationId: 'S1' }]);
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(1);

    // 同 policy/routeGraph，但候选集合不同（candidateSetHash 不同）→ 不复用，重新计算。
    await svc.buildMatrix(snapshot, TASK, [{ personId: 'p2', deviceId: 'd2', stationId: 'S1' }]);
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(2); // 两次 buildMatrix 各计算 1 候选
  });

  it('Task 4：相同输入（同 policy/routeGraph/hash/candidates）→ 命中缓存不复算', async () => {
    const routeOk = {
      routeId: 'R', distanceMeters: 15, etaSeconds: 15, nodes: ['A', 'B'], geometry: [],
      source: 'route_graph', riskLevel: null, graphVersion: null,
      calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
    };
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue(routeOk),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const candidates = [{ personId: 'p1', deviceId: 'd1', stationId: 'S1' }];
    const first = await svc.buildMatrix(snapshot, TASK, candidates, 'org-1');
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(1);

    const second = await svc.buildMatrix(snapshot, TASK, candidates, 'org-1');
    expect(routing.calculateRouteBetween).toHaveBeenCalledTimes(1); // 命中缓存，未重算
    expect(second.matrixId).toBe(first.matrixId);
  });

  it('Task 4 / P0-4：persistMatrix 写入 routeGraphVersion / candidateSetHash 列（与 DB 全键对齐）', async () => {
    const { svc, rows } = makeSvc({ calculateRouteBetween: jest.fn() });
    const cand = { personId: 'p1', deviceId: null, stationId: 'S1' };
    const hash = candidateSetHash([cand]);
    const matrix: RouteCostMatrix = {
      matrixId: `RCM-7-${hash}-1-t1`,
      snapshotVersion: 'WS-MATRIX-0001',
      policyVersion: 3,
      solverVersion: 'heuristic-v2',
      routeGraphVersion: 7,
      candidateSetHash: hash,
      taskId: 't1',
      candidates: [
        {
          personId: 'p1', deviceId: null, stationId: 'S1', etaSeconds: 10, distanceMeters: 10,
          congestion: 1, blocked: false, forbiddenZone: false, risk: 1, energy: 0,
          routeCostMode: 'euclidean_fallback', fallbackReason: 'no_route_edge', dataQuality: 'FRESH', feasible: true,
        },
      ],
      generatedAt: new Date().toISOString(),
    };
    await svc.persistMatrix(matrix, 'org-1');
    expect(rows).toHaveLength(1);
    // 与 standalone_026 全键唯一索引列对齐（route_graph_version 数值序列化为字符串）。
    expect(rows[0]).toMatchObject({
      routeGraphVersion: '7',
      candidateSetHash: hash,
    });
  });

  it('Task 4：candidateSetHash 确定性（相同输入同哈希、顺序无关、不同输入不同哈希）', () => {
    const a = [{ personId: 'p1', deviceId: 'd1', stationId: 'S1' }];
    const b = [{ personId: 'p2', deviceId: 'd2', stationId: 'S2' }];
    expect(candidateSetHash(a)).toBe(candidateSetHash([{ stationId: 'S1', personId: 'p1', deviceId: 'd1' }]));
    // 候选顺序无关。
    expect(candidateSetHash([{ personId: 'p1', deviceId: null, stationId: null }, { personId: 'p2', deviceId: null, stationId: null }]))
      .toBe(candidateSetHash([{ personId: 'p2', deviceId: null, stationId: null }, { personId: 'p1', deviceId: null, stationId: null }]));
    // 不同输入 → 不同哈希。
    expect(candidateSetHash(a)).not.toBe(candidateSetHash(b));
  });

  it('buildEligibilityMatrix：仅矩阵判定 feasible 的人员候选进入（缺坐标候选被排除）', async () => {
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'ROUTE-1', distanceMeters: 10, etaSeconds: 10, nodes: ['A'], geometry: [],
        source: 'route_graph', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: null, dataQuality: 'FRESH',
      }),
    });
    const snapshot = baseSnapshot({
      tasks: [TASK],
      persons: [
        { id: 'p-feasible', name: 'p-feasible', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
        { id: 'p-unknown', name: 'p-unknown', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: null, y: null },
      ],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
      devices: [
        { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', x: 1, y: 1 },
        { id: 'd2', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', x: null, y: null },
      ],
    });
    // p-unknown 走 calculateRoute（spatial 解析失败 → 不可行）。
    routing.calculateRoute.mockResolvedValue({
      routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
      source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
      calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'coords_unknown', dataQuality: 'UNKNOWN',
    });
    const eligible = await svc.buildEligibilityMatrix(snapshot);
    const t1 = eligible.get('t1')!;
    expect(t1.personIds).toContain('p-feasible');
    expect(t1.personIds).not.toContain('p-unknown');
    // 设备：仅真实坐标（d1）进入；d2 坐标未知被排除。
    expect(t1.deviceIds).toContain('d1');
    expect(t1.deviceIds).not.toContain('d2');
  });

  it('§5.4 STRICT：无 route graph 时 euclidean fallback 候选 feasible=false（route_infeasible）', async () => {
    const { svc, routing, policy } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
        source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'no_route_edge', dataQuality: 'FRESH',
      }),
    });
    (policy.getConfig as jest.Mock).mockResolvedValue({ walkingSpeedMps: 1, routeCostMode: 'STRICT' });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    const c = matrix.candidates[0];
    // 降级标记保留（source/fallbackReason/dataQuality 不变），仅可行态被 STRICT 收紧。
    expect(c.routeCostMode).toBe('euclidean_fallback');
    expect(c.fallbackReason).toBe('no_route_edge');
    expect(c.dataQuality).toBe('FRESH');
    expect(c.feasible).toBe(false);
  });

  it('§5.4 DEGRADED（缺省未配置 routeCostMode）：降级候选可行、带 fallbackReason/dataQuality（现状回归）', async () => {
    const { svc, routing } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'euclidean-fallback', distanceMeters: 0, etaSeconds: 0, nodes: [], geometry: [],
        source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: false, fallbackReason: 'no_route_edge', dataQuality: 'FRESH',
      }),
    });
    // makeSvc 缺省 getConfig 返回 { walkingSpeedMps: 1 }（无 routeCostMode → 缺省 DEGRADED 行为）。
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    const c = matrix.candidates[0];
    expect(c.routeCostMode).toBe('euclidean_fallback');
    expect(c.fallbackReason).toBe('no_route_edge');
    expect(c.dataQuality).toBe('FRESH');
    expect(c.feasible).toBe(true); // 缺省 DEGRADED：降级候选可行
  });

  it('15.4 fault-injection：graph_unavailable 候选显式标记（euclidean_fallback / fallbackReason / dataQuality=STALE），绝不作为权威 route_graph', async () => {
    const { svc } = makeSvc({
      calculateRouteBetween: jest.fn().mockResolvedValue({
        routeId: 'euclidean-fallback', distanceMeters: 50, etaSeconds: 50, nodes: [], geometry: [],
        source: 'euclidean_fallback', riskLevel: null, graphVersion: null,
        calculatedAt: new Date().toISOString(), feasible: true, fallbackReason: 'graph_unavailable', dataQuality: 'STALE',
      }),
    });
    const snapshot = baseSnapshot({
      persons: [{ id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
    });
    const matrix = await svc.buildMatrix(snapshot, TASK, [
      { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
    ]);
    const c = matrix.candidates[0];
    // 15.6：降级可观测 —— 候选成本显式标记为 euclidean 降级，绝不静默当作权威路线。
    expect(c.routeCostMode).toBe('euclidean_fallback');
    expect(c.fallbackReason).toBe('graph_unavailable');
    expect(c.dataQuality).toBe('STALE');
    expect(c.feasible).toBe(true); // DEGRADED 缺省：显式降级而非静默不可行
  });
});
