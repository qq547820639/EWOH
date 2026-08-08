import { RoutingService, nearestNodeId } from '../routing.service';
import { ewohRouteNode, ewohRouteEdge } from '@server/database/schema';

describe('nearestNodeId（真实路线最近节点解析）', () => {
  const nodes = [
    { nodeId: 'A', x: 0, y: 0 },
    { nodeId: 'B', x: 10, y: 0 },
    { nodeId: 'C', x: 5, y: 0 },
  ];

  it('不同的坐标点解析到不同的最近节点', () => {
    expect(nearestNodeId(nodes, 0, 0)).toBe('A');
    expect(nearestNodeId(nodes, 10, 0)).toBe('B');
    expect(nearestNodeId(nodes, 5, 0)).toBe('C');
  });

  it('空图返回 null', () => {
    expect(nearestNodeId([], 0, 0)).toBeNull();
  });

  it('距离有歧义时取首个最近节点（确定性）', () => {
    // (5,0) 距 A(0,0) 与 C(5,0)：C 必选；(4,0) 仍选 C
    expect(nearestNodeId(nodes, 4, 0)).toBe('C');
  });
});

describe('RoutingService.calculateRouteBetween（真实路线）', () => {
  const nodeRows = [
    { nodeId: 'A', nodeType: 'station', x: 0, y: 0, floor: '1', stationId: 'st1', zoneId: null },
    { nodeId: 'B', nodeType: 'junction', x: 10, y: 0, floor: '1', stationId: null, zoneId: null },
    { nodeId: 'C', nodeType: 'station', x: 5, y: 0, floor: '1', stationId: 'st2', zoneId: null },
  ];
  const edgeRows = [
    { edgeId: 'e1', fromNodeId: 'A', toNodeId: 'B', distanceMeters: 10, expectedTimeSeconds: 10, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
    { edgeId: 'e2', fromNodeId: 'B', toNodeId: 'C', distanceMeters: 5, expectedTimeSeconds: 5, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
  ];

  const makeDb = () => ({
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) =>
        table === ewohRouteNode
          ? Promise.resolve(nodeRows)
          : Promise.resolve(edgeRows),
      ),
    })),
  });

  it('不同 person/task 起终点 → 走真实 route graph，source=route_graph', async () => {
    const svc = new RoutingService(makeDb() as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    // 起点 (0,0)→A，终点 (5,0)→C
    const route = await svc.calculateRouteBetween(
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { personId: 'p1', taskId: 't1' },
    );
    expect(route.source).toBe('route_graph');
    expect(route.feasible).toBe(true);
    expect(route.nodes).toEqual(['A', 'B', 'C']);
    expect(route.distanceMeters).toBe(15);
    expect(route.personId).toBe('p1');
    expect(route.taskId).toBe('t1');
  });

  it('起终点都落在同一节点 → 不可达，回退 euclidean_fallback', async () => {
    const svc = new RoutingService(makeDb() as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween(
      { x: 0, y: 0 },
      { x: 0.1, y: 0.1 },
    );
    expect(route.source).toBe('euclidean_fallback');
    expect(route.nodes).toEqual([]);
  });

  it('无路由图（无节点）→ euclidean_fallback，坐标齐全时 feasible=true', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => Promise.resolve([])),
      })),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween({ x: 0, y: 0 }, { x: 5, y: 5 });
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(true);
  });

  it('P1-ROUTE-001：euclidean_fallback 距离>0 时 ETA>0（按 walkingSpeed 计算）', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => Promise.resolve([])),
      })),
    };
    // walkingSpeed=2 m/s，距离 100m → ETA=50s
    const svc = new RoutingService(db as never, {
      getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 2.0 }),
    } as never);
    const route = await svc.calculateRouteBetween({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(route.source).toBe('euclidean_fallback');
    expect(route.distanceMeters).toBeGreaterThan(0);
    expect(route.etaSeconds).toBe(50);
  });

  it('P1-ROUTE-001：blocked 边被跳过（A* 绕行或不可达走 fallback）', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) =>
          table === ewohRouteNode
            ? Promise.resolve([
                { nodeId: 'A', nodeType: 'station', x: 0, y: 0, floor: '1', stationId: 'st1', zoneId: null },
                { nodeId: 'C', nodeType: 'station', x: 5, y: 0, floor: '1', stationId: 'st2', zoneId: null },
              ])
            : Promise.resolve([
                {
                  edgeId: 'e1',
                  fromNodeId: 'A',
                  toNodeId: 'C',
                  distanceMeters: 10,
                  expectedTimeSeconds: 10,
                  direction: null,
                  capacity: null,
                  riskLevel: null,
                  status: 'blocked',
                  accessibleFor: [],
                },
              ]),
        ),
      })),
    };
    const svc = new RoutingService(db as never, {
      getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }),
    } as never);
    const route = await svc.calculateRouteBetween({ x: 0, y: 0 }, { x: 5, y: 0 });
    // A→C 唯一边被 blocked → A* 不可达 → euclidean fallback
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(true);
  });

  it('P1-ROUTE-001：congested 边 A* 走通且 ETA 为真实路径时间', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) =>
          table === ewohRouteNode
            ? Promise.resolve([
                { nodeId: 'A', nodeType: 'station', x: 0, y: 0, floor: '1', stationId: 'st1', zoneId: null },
                { nodeId: 'B', nodeType: 'junction', x: 5, y: 0, floor: '1', stationId: null, zoneId: null },
                { nodeId: 'C', nodeType: 'station', x: 10, y: 0, floor: '1', stationId: 'st2', zoneId: null },
              ])
            : Promise.resolve([
                {
                  edgeId: 'e1',
                  fromNodeId: 'A',
                  toNodeId: 'B',
                  distanceMeters: 5,
                  expectedTimeSeconds: 5,
                  direction: null,
                  capacity: null,
                  riskLevel: null,
                  status: 'open',
                  accessibleFor: [],
                },
                {
                  edgeId: 'e2',
                  fromNodeId: 'B',
                  toNodeId: 'C',
                  distanceMeters: 5,
                  expectedTimeSeconds: 5,
                  direction: null,
                  capacity: null,
                  riskLevel: null,
                  status: 'congested',
                  accessibleFor: [],
                },
              ]),
        ),
      })),
    };
    const svc = new RoutingService(db as never, {
      getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }),
    } as never);
    const route = await svc.calculateRouteBetween({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(route.source).toBe('route_graph');
    expect(route.etaSeconds).toBeGreaterThan(0);
    expect(route.nodes).toHaveLength(3);
  });

  it('坐标缺失（NaN）→ euclidean_fallback 且 feasible=false', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => Promise.resolve([])),
      })),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween({ x: NaN, y: 0 }, { x: 5, y: 5 });
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(false);
  });
});