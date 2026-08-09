/* Phase 2 / P2-T1：TravelCostService RouteCostMatrix 测试。
 *
 * 覆盖：buildMatrix 逐候选聚合（route_graph / coords_unknown / no_route_edge）、
 * forbiddenZone / blocked 矩阵层显式标记、feasible 语义、缓存读写（决策 D-D）。
 */
/// <reference types="jest" />
import { TravelCostService } from '../travel-cost.service';
import { ewohRouteCostMatrix } from '@server/database/schema';
import type { RouteCostMatrix, WorldStateSnapshot } from '@shared/api.interface';

const HOUR = 3600_000;

/** 内存态 fake db（支持 select().from().where().limit() 与 insert/update）。 */
function makeFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
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
        rows.push({ ...(values as Record<string, unknown>) });
        return { returning: () => Promise.resolve([rows[rows.length - 1]]) };
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
      persons: [{ id: 'p1', name: 'p1', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
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
      persons: [{ id: 'p-unknown', name: 'p-unknown', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: null, y: null }],
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
      persons: [{ id: 'p1', name: 'p1', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z-FORBIDDEN', x: 0, y: 0 }],
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
      persons: [{ id: 'p1', name: 'p1', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 }],
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

  it('决策 D-D：矩阵落库缓存（persistMatrix 写、getCachedMatrix 读、同键幂等覆盖）', async () => {
    const { svc, rows } = makeSvc({ calculateRouteBetween: jest.fn() });
    const matrix: RouteCostMatrix = {
      matrixId: 'RCM-1-t1',
      snapshotVersion: 'WS-MATRIX-0001',
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
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
    await svc.persistMatrix(matrix);
    expect(rows).toHaveLength(1);

    const cached = await svc.getCachedMatrix('t1', 'WS-MATRIX-0001');
    expect(cached).not.toBeNull();
    expect(cached!.taskId).toBe('t1');
    expect(cached!.candidates[0].personId).toBe('p1');
    expect(cached!.candidates[0].feasible).toBe(true);

    // 幂等覆盖：再次写不新增行。
    await svc.persistMatrix(matrix);
    expect(rows).toHaveLength(1);
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
        { id: 'p-feasible', name: 'p-feasible', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
        { id: 'p-unknown', name: 'p-unknown', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: null, y: null },
      ],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
      devices: [
        { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'online', x: 1, y: 1 },
        { id: 'd2', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'online', x: null, y: null },
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
});
