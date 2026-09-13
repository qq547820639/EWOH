import { RoutingService, nearestNodeId } from '../routing.service';
import { ewohRouteNode, ewohRouteEdge } from '@server/database/schema';
import { TravelCostService } from '../travel-cost.service';
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import { SchedulerQueryService } from '../scheduler-query.service';
import { makeDispatchCoordinator } from './dispatch-test-harness';
import {
  buildSnapshot,
  defaultConfig,
  defaultPolicy,
  device as seedDevice,
  person as seedPerson,
  task as seedTask,
} from './scheduler-test-helpers';
import type { OrgContext } from '@server/modules/shared/org-context.interceptor';

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

  it('P2-T1：坐标缺失 → fallbackReason=coords_unknown / dataQuality=UNKNOWN（绝不 0,0 伪坐标）', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([])),
          })),
        })),
      })),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRoute('p-no-coords', 't-no-coords');
    expect(route.feasible).toBe(false);
    expect(route.fallbackReason).toBe('coords_unknown');
    expect(route.dataQuality).toBe('UNKNOWN');
  });

  it('P2-T1：route graph 不可达（无节点）→ fallbackReason=no_route_edge / dataQuality=FRESH', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => Promise.resolve([])),
      })),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween({ x: 0, y: 0 }, { x: 5, y: 5 });
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(true);
    expect(route.fallbackReason).toBe('no_route_edge');
    expect(route.dataQuality).toBe('FRESH');
  });

  it('P2-T1：route graph 走通 → fallbackReason=null / dataQuality=FRESH', async () => {
    const svc = new RoutingService(makeDb() as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween(
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { personId: 'p1', taskId: 't1' },
    );
    expect(route.source).toBe('route_graph');
    expect(route.fallbackReason).toBeNull();
    expect(route.dataQuality).toBe('FRESH');
  });

  it('15.4 fault-injection：route graph 加载失败（DB 临时故障）→ 显式 degraded euclidean fallback（graph_unavailable / STALE），绝不静默当权威路线', async () => {
    const db = {
      select: jest.fn(() => {
        throw new Error('server closed the connection unexpectedly (57P01)');
      }),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween(
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { personId: 'p1', taskId: 't1' },
    );
    // 15.6：降级可观测 —— source/fallbackReason/dataQuality 显式标记，绝不抛异常、
    // 绝不返回 source=route_graph（不被当作权威路线）。
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(true);
    expect(route.fallbackReason).toBe('graph_unavailable');
    expect(route.dataQuality).toBe('STALE');
    expect(route.nodes).toEqual([]);
    expect(route.distanceMeters).toBeGreaterThan(0); // 欧氏仍给出有效参考成本
  });

  it('15.4 fault-injection：graph 加载失败且坐标缺失 → 显式不可行（graph_unavailable / STALE / feasible=false）', async () => {
    const db = {
      select: jest.fn(() => {
        throw new Error('connection refused');
      }),
    };
    const svc = new RoutingService(db as never, { getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0 }) } as never);
    const route = await svc.calculateRouteBetween({ x: NaN, y: 0 }, { x: 5, y: 5 });
    expect(route.source).toBe('euclidean_fallback');
    expect(route.feasible).toBe(false);
    expect(route.fallbackReason).toBe('graph_unavailable');
    expect(route.dataQuality).toBe('STALE');
  });
});

/**
 * WP-C（2026-09-13 审计）：路由图缓存的租户隔离。
 *
 * 修复前 graphCache 键为 `orgIdOf(actor) ?? '__all__'`——actor 缺失或
 * global_admin 无归属组织时，多个租户的"按当前请求 RLS 过滤后的"图共用同一个
 * 进程级 '__all__' 桶，先写入者决定后续所有租户读到什么（跨租户拓扑泄漏）。
 * 修复后：无具体租户键一律读穿不缓存。
 *
 * 测试用可切换的 dbTag 模拟"当前请求 RLS 视角返回的行"：同一个 select 在不同
 * 请求上下文下返回不同租户的拓扑，从而让"命中公共桶"这件事可观测。
 */
describe('RoutingService.loadGraph（路由图缓存租户隔离）', () => {
  let dbTag = 'none';

  /** 未传 actor 时 from(...) 直接 await，传 actor 时链式 .where(...)：返回值须兼两者。 */
  const makeDb = () => ({
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const rows =
          table === ewohRouteNode
            ? [
                {
                  nodeId: dbTag,
                  nodeType: 'station',
                  x: 0,
                  y: 0,
                  floor: null,
                  stationId: null,
                  zoneId: null,
                },
              ]
            : [];
        const promise = Promise.resolve(rows) as Promise<unknown[]> & {
          where: jest.Mock;
        };
        promise.where = jest.fn(() => Promise.resolve(rows));
        return promise;
      }),
    })),
  });

  const nodeIdOf = (graph: { nodes: Array<{ nodeId: string }> }) =>
    graph.nodes[0]?.nodeId;
  const policyStub = () => ({ getConfig: jest.fn() });

  beforeEach(() => {
    dbTag = 'none';
  });

  it('核心不变量：无 actor（按当前请求 RLS 过滤）的图绝不跨租户共享', async () => {
    const svc = new RoutingService(makeDb() as never, policyStub() as never);
    // 租户 A 的请求（RLS → A 的拓扑）先加载
    dbTag = 'A';
    expect(nodeIdOf(await svc.loadGraph())).toBe('A');
    // 租户 B 的请求（RLS → B 的拓扑）后加载：修复前命中进程级 '__all__' 桶 → 'A'（泄漏）
    dbTag = 'B';
    expect(nodeIdOf(await svc.loadGraph())).toBe('B');
  });

  it('global_admin 无归属组织：全量视图不落入任何租户可读到的桶', async () => {
    const svc = new RoutingService(makeDb() as never, policyStub() as never);
    // 全局管理员（primaryOrgId 为空，RLS 返回全部 org 的拓扑）
    dbTag = 'ALL';
    const admin = await svc.loadGraph({
      userId: 'admin-1',
      primaryOrgId: '',
      isGlobalAdmin: true,
    } as never);
    expect(nodeIdOf(admin)).toBe('ALL');
    // 紧随其后的普通租户（无 actor，RLS → B）绝不能读到管理员的跨 org 全量图
    dbTag = 'B';
    expect(nodeIdOf(await svc.loadGraph())).toBe('B');
  });

  it('无 actor 的调用不缓存：每次按当前 RLS 重新加载（杜绝跨租户复用）', async () => {
    const db = makeDb();
    const svc = new RoutingService(db as never, policyStub() as never);
    dbTag = 'A';
    await svc.loadGraph();
    const callsAfterFirst = db.select.mock.calls.length;
    await svc.loadGraph();
    // 修复前第二个调用命中 '__all__' 桶（select 次数不变）→ 断言失败
    expect(db.select.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('显式租户调用仍按租户分桶缓存，A 的桶不被 B 覆盖且 TTL 内复用', async () => {
    const db = makeDb();
    const svc = new RoutingService(db as never, policyStub() as never);
    dbTag = 'A';
    expect(nodeIdOf(await svc.loadGraph('org-A'))).toBe('A');
    dbTag = 'B';
    expect(nodeIdOf(await svc.loadGraph('org-B'))).toBe('B');
    // 再回 org-A：命中自己的桶（不重查），证明 B 未覆盖 A
    dbTag = 'X';
    expect(nodeIdOf(await svc.loadGraph('org-A'))).toBe('A');
    // TTL 内复用：无新的 DB select
    const calls = db.select.mock.calls.length;
    await svc.loadGraph('org-A');
    expect(db.select.mock.calls.length).toBe(calls);
  });

  it('global_admin 有归属组织：按该租户桶隔离，不与其它租户混用', async () => {
    const svc = new RoutingService(makeDb() as never, policyStub() as never);
    dbTag = 'A';
    await svc.loadGraph({
      userId: 'admin-2',
      primaryOrgId: 'org-A',
      isGlobalAdmin: true,
    } as never);
    dbTag = 'Z';
    // org-B 调用不得读到 org-A 的桶
    expect(nodeIdOf(await svc.loadGraph('org-B'))).toBe('Z');
  });
});

/**
 * R-6（2026-09-13）：删除无租户键缓存后的性能回归——生产热路径必须透传 orgId。
 *
 * 背景：graphCache 取消 `__all__` 共享桶（跨租户泄漏修复，方向正确）后，
 * 凡是不传 orgId 的 estimate 调用都退化为"读穿不缓存"，每个候选全图 SELECT
 * route_node/route_edge。热路径（候选池 / 批量路由 / 派工 ADVISORY 判定）
 * 本就持有本请求的租户，缺的只是"告诉路由层我是哪个租户"。
 *
 * 本块锁定两条不变量：
 *  1) 热路径调用点把本租户 orgId 透传到 estimate（否则回到 N+1 全图读）；
 *  2) 透传后仍按租户分桶——同租户 TTL 内命中缓存（DB select 次数不增），
 *     不同租户各自分桶、互不覆盖；确实无租户的调用保持读穿不缓存（不伪造 org）。
 */
describe('R-6：estimate 透传 orgId 后路由图按租户分桶缓存（性能回归）', () => {
  const nodeRows = [
    { nodeId: 'A', nodeType: 'station', x: 0, y: 0, floor: '1', stationId: 'st1', zoneId: null },
    { nodeId: 'B', nodeType: 'junction', x: 5, y: 0, floor: '1', stationId: null, zoneId: null },
    { nodeId: 'C', nodeType: 'station', x: 10, y: 0, floor: '1', stationId: 'st2', zoneId: null },
  ];
  const edgeRows = [
    { edgeId: 'e1', fromNodeId: 'A', toNodeId: 'B', distanceMeters: 5, expectedTimeSeconds: 5, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
    { edgeId: 'e2', fromNodeId: 'B', toNodeId: 'C', distanceMeters: 5, expectedTimeSeconds: 5, direction: null, capacity: null, riskLevel: null, status: 'open', accessibleFor: [] },
  ];

  /** 带 org 谓词（.where(...)）的 select 替身；每次 loadGraphUncached = 2 次 select。 */
  const makeDb = () => ({
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const rows = table === ewohRouteNode ? nodeRows : edgeRows;
        const promise = Promise.resolve(rows) as Promise<unknown[]> & { where: jest.Mock };
        promise.where = jest.fn(() => Promise.resolve(rows));
        return promise;
      }),
    })),
  });

  const policyStub = () => ({
    getConfig: jest.fn().mockResolvedValue({ walkingSpeedMps: 1.0, routeCostMode: 'DEGRADED' }),
    getActivePolicy: jest.fn(),
  });

  const makeTravel = () => {
    const db = makeDb();
    const policy = policyStub();
    const routing = new RoutingService(db as never, policy as never);
    const travel = new TravelCostService(db as never, routing, policy as never);
    return { db, travel };
  };

  const FROM = { x: 0, y: 0 };
  const TO = { x: 10, y: 0 };

  it('不变量 2a：同一租户重复 estimate 命中图缓存（DB select 次数不增）', async () => {
    const { db, travel } = makeTravel();
    const first = await travel.estimate('p1', 't1', FROM, TO, { orgId: 'org-A' });
    expect(first.source).toBe('route_graph');
    const afterFirst = db.select.mock.calls.length; // 一次图加载：route_node + route_edge
    const second = await travel.estimate('p2', 't2', FROM, TO, { orgId: 'org-A' });
    expect(second.source).toBe('route_graph');
    // 修复前（不传 orgId）这里会再触发一次全图 SELECT → 断言失败
    expect(db.select.mock.calls.length).toBe(afterFirst);
  });

  it('不变量 2b：不同租户各自分桶——B 的加载不覆盖 A，A 再次调用仍命中自己的桶', async () => {
    const { db, travel } = makeTravel();
    await travel.estimate('p1', 't1', FROM, TO, { orgId: 'org-A' });
    const afterA = db.select.mock.calls.length;
    await travel.estimate('p1', 't1', FROM, TO, { orgId: 'org-B' });
    const afterB = db.select.mock.calls.length;
    expect(afterB).toBeGreaterThan(afterA); // B 首次 → 加载 B 自己的图
    await travel.estimate('p1', 't1', FROM, TO, { orgId: 'org-A' });
    // A 仍命中 A 的桶（未被 B 覆盖），没有新的 DB 读
    expect(db.select.mock.calls.length).toBe(afterB);
  });

  it('不变量 2c：无 orgId 的调用保持读穿不缓存（不伪造 org 换命中率）', async () => {
    const { db, travel } = makeTravel();
    await travel.estimate('p1', 't1', FROM, TO);
    const afterFirst = db.select.mock.calls.length;
    await travel.estimate('p1', 't1', FROM, TO);
    expect(db.select.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('R-6：热路径调用点透传本租户 orgId（不变量 1）', () => {
  const ROUTE_COST = {
    routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null, feasible: true,
    source: 'route_graph', riskCost: 0, congestionCost: 0, graphVersion: null,
    calculatedAt: new Date().toISOString(), fallbackReason: null, dataQuality: 'FRESH',
    geometry: [],
  };
  const ACTOR: OrgContext = { userId: 'u1', primaryOrgId: 'org-A' };

  const makeSnapshot = () =>
    buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      tasks: [{ ...seedTask({ id: 't1' }), stationId: 'S1', zoneId: 'Z1' }],
      devices: [seedDevice({ id: 'd1' })],
      stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 }],
      lockedAssignments: [],
    });

  it('CandidateEngine.buildCandidatePool：每个 estimate 都带 opts.orgId', async () => {
    const routeCostProvider = { estimate: jest.fn().mockResolvedValue(ROUTE_COST) };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    };
    const engine = new CandidateEngineService(
      { getCurrentWorldState: jest.fn(), buildSnapshot: jest.fn() } as never,
      {} as never,
      new EligibilityService(),
      routeCostProvider as never,
      policy as never,
    );
    const snap = makeSnapshot();
    await engine.buildCandidatePool(snap.tasks[0], snap, { nowMs: 0, orgId: 'org-A' });
    expect(routeCostProvider.estimate).toHaveBeenCalled();
    for (const call of routeCostProvider.estimate.mock.calls) {
      expect(call[4]).toEqual({ orgId: 'org-A' });
    }
  });

  it('CandidateEngine.buildCandidatePool：无 orgId 时传 null（不伪造租户）', async () => {
    const routeCostProvider = { estimate: jest.fn().mockResolvedValue(ROUTE_COST) };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    };
    const engine = new CandidateEngineService(
      { getCurrentWorldState: jest.fn(), buildSnapshot: jest.fn() } as never,
      {} as never,
      new EligibilityService(),
      routeCostProvider as never,
      policy as never,
    );
    const snap = makeSnapshot();
    await engine.buildCandidatePool(snap.tasks[0], snap, { nowMs: 0 });
    expect(routeCostProvider.estimate).toHaveBeenCalled();
    for (const call of routeCostProvider.estimate.mock.calls) {
      expect(call[4]).toEqual({ orgId: null });
    }
  });

  it('CandidateEngine.evaluateTaskCandidates：端点把 actor.primaryOrgId 透传进候选池', async () => {
    const routeCostProvider = { estimate: jest.fn().mockResolvedValue(ROUTE_COST) };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    };
    const engine = new CandidateEngineService(
      { getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()), buildSnapshot: jest.fn() } as never,
      {} as never,
      new EligibilityService(),
      routeCostProvider as never,
      policy as never,
    );
    await engine.evaluateTaskCandidates('t1', ACTOR);
    expect(routeCostProvider.estimate).toHaveBeenCalled();
    for (const call of routeCostProvider.estimate.mock.calls) {
      expect(call[4]).toEqual({ orgId: 'org-A' });
    }
  });

  it('SchedulerQuery.getTaskCandidates（回退路径）：estimate 带 actor org', async () => {
    const routeCostProvider = { estimate: jest.fn().mockResolvedValue(ROUTE_COST) };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    };
    const svc = new SchedulerQueryService(
      {} as never,
      { getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()) } as never,
      {} as never,
      {} as never,
      policy as never,
      {} as never,
      new EligibilityService(),
      routeCostProvider as never,
      undefined, // 未注入候选引擎 → 走服务内回退实现（本用例覆盖的回退分支）
    );
    await svc.getTaskCandidates('t1', ACTOR);
    expect(routeCostProvider.estimate).toHaveBeenCalled();
    for (const call of routeCostProvider.estimate.mock.calls) {
      expect(call[4]).toEqual({ orgId: 'org-A' });
    }
  });

  it('SchedulerQuery.calculateRouteV2（批量候选）：estimate 带 actor org', async () => {
    const routeCostProvider = { estimate: jest.fn().mockResolvedValue(ROUTE_COST) };
    const policy = {
      getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
      getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    };
    const svc = new SchedulerQueryService(
      {} as never,
      { getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()) } as never,
      {} as never,
      {} as never,
      policy as never,
      {} as never,
      new EligibilityService(),
      routeCostProvider as never,
      undefined,
    );
    await svc.calculateRouteV2(
      { personId: 'p1', taskId: 't1', candidates: [{ personId: 'p1' }] },
      ACTOR,
    );
    expect(routeCostProvider.estimate).toHaveBeenCalledWith(
      'p1',
      't1',
      expect.anything(),
      expect.anything(),
      { orgId: 'org-A' },
    );
  });

  it('DispatchCoordinator（ADVISORY 分支）：estimate 带 ctx.primaryOrgId', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [{ planId: 'PLAN-R6', status: 'approved', snapshotVersion: 'WS-R6' }],
      assignments: [
        { assignmentId: 'ASG-R6', planId: 'PLAN-R6', taskId: 'T-R6', personId: 'p1', status: 'approved' },
      ],
      tasks: [{ id: 'T-R6', status: 'pending_dispatch', safetyCritical: true }],
    });
    (mocks.policyService.getConfig as jest.Mock).mockResolvedValue({
      defaultTaskDurationMs: 1_800_000,
      routeCostMode: 'ADVISORY',
    });
    (mocks.travelCostService.estimate as jest.Mock).mockResolvedValue({
      ...ROUTE_COST,
      source: 'euclidean_fallback',
      fallbackReason: 'no_route_edge',
    });

    await expect(
      svc.dispatch('PLAN-R6', { userId: 'u1', primaryOrgId: 'org1' }),
    ).rejects.toThrow('SAFETY_CRITICAL_DEGRADED_ROUTE');
    expect(mocks.travelCostService.estimate).toHaveBeenCalledWith(
      'p1',
      'T-R6',
      undefined,
      undefined,
      { orgId: 'org1' },
    );
  });
});