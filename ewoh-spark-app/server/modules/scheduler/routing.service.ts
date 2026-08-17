import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, or, isNull, and } from 'drizzle-orm';
import { ewohRouteNode, ewohRouteEdge, ewohSpatialEntity } from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';
import { SchedulingPolicyService } from './scheduling-policy.service';
import type {
  Route,
  RouteGraph,
  RouteGraphEdge,
  RouteGraphNode,
} from '@shared/api.interface';

/** 内部 A* 图中使用的节点。 */
interface GraphNode {
  nodeId: string;
  x: number;
  y: number;
}

/** 平面坐标点。 */
export interface Point {
  x: number;
  y: number;
}

/**
 * 纯函数：在给定节点集中查找离 (x, y) 欧氏距离最近的节点 id。
 * 空图返回 null。抽成可导出纯函数便于单元测试。
 */
export function nearestNodeId(
  nodes: Array<{ nodeId: string; x: number; y: number }>,
  x: number,
  y: number,
): string | null {
  if (nodes.length === 0) return null;
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = n.nodeId;
    }
  }
  return best;
}

/**
 * 路由服务：从 ewoh_route_node / ewoh_route_edge 加载路由图，
 * 使用 A* 计算最短路径（边代价叠加拥塞/风险系数，跳过阻塞边）。
 * 起终点一律通过真实坐标解析最近节点，避免"首/末节点"盲回退。
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  /** P1-SCHED-003：路由边代价系数缓存（来自 versioned policy）。 */
  private edgeFactors: {
    congestedFactor: number;
    blockedFactor: number;
    highRiskFactor: number;
    mediumRiskFactor: number;
  } | null = null;

  /**
   * NEST-133（2026-08-17）：策略边代价系数 TTL 缓存时间戳。此前每次
   * calculateRouteBetween 都 refreshEdgeFactors（一次 policy 查询），
   * 候选矩阵 N×M 次路由计算即 N×M 次 DB 读。策略版本翻转频率远低于
   * 路由计算，30s TTL 足够新鲜且消除 N+1。
   */
  private edgeFactorsRefreshedAt = 0;
  private static readonly EDGE_FACTORS_TTL_MS = 30_000;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /**
   * NEST-118（2026-08-17）：路由计算统一接受 actor（OrgContext）或裸 orgId，
   * 图加载/坐标解析按 org 过滤；缺省 = 系统后台流（GUC/RLS 兜底）。
   */
  private orgIdOf(actor?: OrgContext | string | null): string | undefined {
    if (!actor) return undefined;
    return typeof actor === 'string' ? actor : actor.primaryOrgId || undefined;
  }

  /** 加载完整路由图。 */
  async loadGraph(actor?: OrgContext | string | null): Promise<RouteGraph> {
    // ADR-074 / NEST-118：路由拓扑读面 org 条件（org 匹配或 NULL 存量，与 RLS 语义等价）。
    const orgId = this.orgIdOf(actor);
    const orgCond = orgId
      ? (col: { orgId: unknown }) =>
          or(isNull(col.orgId as never), eq(col.orgId as never, orgId))
      : undefined;
    const [nodeRows, edgeRows] = await Promise.all([
      orgCond
        ? this.db.select().from(ewohRouteNode).where(orgCond(ewohRouteNode))
        : this.db.select().from(ewohRouteNode),
      orgCond
        ? this.db.select().from(ewohRouteEdge).where(orgCond(ewohRouteEdge))
        : this.db.select().from(ewohRouteEdge),
    ]);

    const nodes: RouteGraphNode[] = nodeRows.map((n) => ({
      nodeId: n.nodeId,
      nodeType: n.nodeType ?? null,
      x: n.x ?? 0,
      y: n.y ?? 0,
      floor: n.floor ?? null,
      stationId: n.stationId ?? null,
      zoneId: n.zoneId ?? null,
    }));

    const edges: RouteGraphEdge[] = edgeRows.map((e) => ({
      edgeId: e.edgeId,
      fromNodeId: e.fromNodeId ?? '',
      toNodeId: e.toNodeId ?? '',
      distanceMeters: e.distanceMeters ?? 0,
      expectedTimeSeconds: e.expectedTimeSeconds ?? 0,
      direction: e.direction ?? null,
      capacity: e.capacity ?? null,
      riskLevel: e.riskLevel ?? null,
      status: (e.status ?? 'open') as RouteGraphEdge['status'],
      accessibleFor: Array.isArray(e.accessibleFor)
        ? (e.accessibleFor as string[])
        : [],
    }));

    return { nodes, edges };
  }

  /**
   * 在 route graph 上求 from→to 的路径（真实路线）。
   * 起点为离 from 最近的节点，终点为离 to 最近的节点。
   * 找到路径 → 返回 source:'route_graph' 与真实 distance/eta/riskLevel；
   * 找不到（无节点/起终点同点/A* 不可达）→ 返回 source:'euclidean_fallback'，
   * feasible 由 from/to 坐标是否齐全决定，并携带 fallbackReason / dataQuality
   * （P2-T1：coords_unknown→UNKNOWN；no_route_edge→FRESH）。从不抛异常。
   */
  async calculateRouteBetween(
    from: Point,
    to: Point,
    meta?: { personId?: string; taskId?: string; graphVersion?: number | null },
    actor?: OrgContext | string | null,
  ): Promise<Route> {
    const personId = meta?.personId ?? 'unknown';
    const taskId = meta?.taskId ?? 'unknown';
    const hasCoords =
      Number.isFinite(from.x) &&
      Number.isFinite(from.y) &&
      Number.isFinite(to.x) &&
      Number.isFinite(to.y);
    // 15.4 fault-injection：route graph 加载失败（DB 临时故障）→ 显式 degraded
    // euclidean fallback（fallbackReason=graph_unavailable / dataQuality=STALE），
    // 满足"从不抛异常"约定；该 Route 显式标记降级，绝不静默当作权威路线。
    let graph: RouteGraph;
    try {
      // NEST-118：图加载透传 actor（org 过滤拓扑）。
      graph = await this.loadGraph(actor);
    } catch (err) {
      this.logger.warn(
        `route graph load failed; explicit degraded euclidean fallback (graph_unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.euclideanRoute(from, to, {
        personId,
        taskId,
        feasible: hasCoords,
        fallbackReason: 'graph_unavailable',
        dataQuality: 'STALE',
      });
    }
    const nodes = graph.nodes.map((n) => ({
      nodeId: n.nodeId,
      x: n.x,
      y: n.y,
    }));
    const fallback = await this.euclideanRoute(from, to, {
      personId,
      taskId,
      feasible: hasCoords,
      fallbackReason: hasCoords ? 'no_route_edge' : 'coords_unknown',
      dataQuality: hasCoords ? 'FRESH' : 'UNKNOWN',
    });

    const startId = nearestNodeId(nodes, from.x, from.y);
    const goalId = nearestNodeId(nodes, to.x, to.y);
    if (!startId || !goalId || startId === goalId) return fallback;

    // P1-SCHED-003：路由边代价系数与 policy 对齐（每次计算刷新，避免陈旧）
    await this.refreshEdgeFactors();
    const path = this.astar(graph, startId, goalId);
    if (!path || path.length < 2) return fallback;

    const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
    const distanceMeters = this.pathDistance(graph, path);
    const etaSeconds = this.pathTime(graph, path);

    return {
      routeId: `ROUTE-${Date.now()}`,
      personId,
      taskId,
      distanceMeters: Math.round(distanceMeters * 100) / 100,
      etaSeconds: Math.round(etaSeconds),
      nodes: path,
      geometry: path
        .map((nid) => nodeById.get(nid))
        .filter((n): n is GraphNode => Boolean(n))
        .map((n) => ({ x: n.x, y: n.y })),
      source: 'route_graph',
      riskLevel: this.routeRiskLevel(graph, path),
      // NEST-135 修复（2026-08-17）：透传调用方的 worldVersion 代理
      // （TravelCostService.routeGraphVersionOf），恢复版本追溯；无版本上下文
      // 的调用（如 nearestNode）保持 null（诚实缺失，不伪造）。
      graphVersion: meta?.graphVersion ?? null,
      calculatedAt: new Date().toISOString(),
      feasible: true,
      fallbackReason: null,
      dataQuality: 'FRESH',
    };
  }

  /**
   * 为人员到任务工位规划一条路径（按 entityId 查真实坐标）。
   * 从 ewoh_spatial_entity 取 person/task 的 x/y，再求最近节点；
   * 查不到坐标 → 显式不可行（feasible=false、fallbackReason=coords_unknown、
   * dataQuality=UNKNOWN），绝不返回 0,0 伪坐标（见 02 §10 修复点）。
   */
  async calculateRoute(
    personId: string,
    taskId: string,
    actor?: OrgContext | string | null,
  ): Promise<Route> {
    // NEST-118：坐标解析按 org 过滤（org 匹配或 NULL 存量，防跨租户实体解析）。
    const orgId = this.orgIdOf(actor);
    const entityCond = (entityId: string) =>
      orgId
        ? and(
            eq(ewohSpatialEntity.entityId, entityId),
            or(
              isNull(ewohSpatialEntity.orgId),
              eq(ewohSpatialEntity.orgId, orgId),
            ),
          )
        : eq(ewohSpatialEntity.entityId, entityId);
    const [personRows, taskRows] = await Promise.all([
      this.db
        .select()
        .from(ewohSpatialEntity)
        .where(entityCond(personId))
        .limit(1),
      this.db
        .select()
        .from(ewohSpatialEntity)
        .where(entityCond(taskId))
        .limit(1),
    ]);
    const from = this.pointFromEntity(personRows[0]);
    const to = this.pointFromEntity(taskRows[0]);
    if (!from || !to) {
      return this.euclideanRoute(from, to, {
        personId,
        taskId,
        feasible: Boolean(from) && Boolean(to),
        fallbackReason: 'coords_unknown',
        dataQuality: 'UNKNOWN',
      });
    }
    return this.calculateRouteBetween(from, to, { personId, taskId }, actor);
  }

  /** P1-ROUTE-001：读取统一行走速度（policy），用于欧氏兜底 ETA 计算。 */
  private async walkingSpeedMps(): Promise<number> {
    try {
      const config = this.policyService
        ? await this.policyService.getConfig()
        : undefined;
      const speed = config?.walkingSpeedMps;
      if (typeof speed === 'number' && speed > 0) return speed;
    } catch (err) {
      this.logger.warn(
        `policy walkingSpeed unavailable, using 1.0 m/s fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 1.0;
  }

  /** 返回离 (x, y) 最近的节点；空图时返回 null。 */
  async nearestNode(x: number, y: number): Promise<RouteGraphNode | null> {
    const graph = await this.loadGraph();
    if (graph.nodes.length === 0) return null;
    let best: RouteGraphNode | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const n of graph.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  /** 从 spatial entity 行提取坐标；无坐标时返回 null。 */
  private pointFromEntity(
    row?: { x?: number | null; y?: number | null },
  ): Point | null {
    if (!row) return null;
    const x = row.x;
    const y = row.y;
    if (
      x == null ||
      y == null ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    return { x, y };
  }

  /** 构造欧氏兜底 Route（不抛异常）。P1-ROUTE-001：ETA 必须由距离/速度计算，禁止返回 0。
   * P2-T1：坐标缺失时显式不可行（fallbackReason=coords_unknown / dataQuality=UNKNOWN），
   * 绝不把 0,0 当作真实坐标参与计算。 */
  private async euclideanRoute(
    from: Point | null,
    to: Point | null,
    meta: {
      personId: string;
      taskId: string;
      feasible: boolean;
      fallbackReason: Route['fallbackReason'];
      dataQuality: Route['dataQuality'];
    },
  ): Promise<Route> {
    const distanceMeters =
      from && to && Number.isFinite(from.x) && Number.isFinite(to.x)
        ? Math.hypot(to.x - from.x, to.y - from.y)
        : 0;
    const speed = await this.walkingSpeedMps();
    const etaSeconds =
      distanceMeters > 0 && speed > 0 ? distanceMeters / speed : 0;
    return {
      routeId: 'euclidean-fallback',
      personId: meta.personId,
      taskId: meta.taskId,
      distanceMeters: Math.round(distanceMeters * 100) / 100,
      etaSeconds: Math.round(etaSeconds),
      nodes: [],
      geometry: [],
      source: 'euclidean_fallback',
      riskLevel: null,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      feasible: meta.feasible,
      fallbackReason: meta.fallbackReason,
      dataQuality: meta.dataQuality,
    };
  }

  /** 沿路径取最高风险等级（high > medium > low/null）。 */
  private routeRiskLevel(graph: RouteGraph, path: string[]): string | null {
    const edgeByKey = new Map<string, RouteGraphEdge>();
    for (const e of graph.edges) {
      edgeByKey.set(`${e.fromNodeId}->${e.toNodeId}`, e);
    }
    let level: string | null = null;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = edgeByKey.get(`${path[i]}->${path[i + 1]}`);
      if (edge?.riskLevel === 'high') return 'high';
      if (edge?.riskLevel === 'medium') level = 'medium';
    }
    return level;
  }

  /** A* 最短路径。返回节点 ID 序列（含起终点），不可达时返回 null。 */
  private astar(
    graph: RouteGraph,
    startId: string,
    goalId: string,
  ): string[] | null {
    const nodeById = new Map(graph.nodes.map((n) => [n.nodeId, n]));
    const start = nodeById.get(startId);
    const goal = nodeById.get(goalId);
    if (!start || !goal) return null;

    const adjacency = new Map<string, Array<{ to: string; cost: number }>>();
    for (const edge of graph.edges) {
      if (edge.status === 'blocked') continue;
      const cost = this.edgeCost(edge);
      if (!adjacency.has(edge.fromNodeId)) adjacency.set(edge.fromNodeId, []);
      adjacency.get(edge.fromNodeId)!.push({ to: edge.toNodeId, cost });
    }

    const open: string[] = [startId];
    // NEST-134（2026-08-17）：open 集合成员判定 O(n) includes → Set O(1)，
    // 大图（万级节点）下消除 O(n²) 扫描。
    const openSet = new Set<string>([startId]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startId, 0]]);
    const fScore = new Map<string, number>([
      [startId, this.heuristic(start, goal)],
    ]);
    const closed = new Set<string>();

    while (open.length > 0) {
      // 取 fScore 最小的节点
      let current = open[0];
      let currentIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if ((fScore.get(open[i]) ?? Infinity) < (fScore.get(current) ?? Infinity)) {
          current = open[i];
          currentIdx = i;
        }
      }
      open.splice(currentIdx, 1);
      openSet.delete(current);

      if (current === goalId) {
        return this.reconstructPath(cameFrom, current);
      }
      closed.add(current);

      const neighbours = adjacency.get(current) ?? [];
      for (const { to, cost } of neighbours) {
        if (closed.has(to)) continue;
        const tentative = (gScore.get(current) ?? Infinity) + cost;
        if (tentative < (gScore.get(to) ?? Infinity)) {
          cameFrom.set(to, current);
          gScore.set(to, tentative);
          const toNode = nodeById.get(to);
          const h = toNode ? this.heuristic(toNode, goal) : 0;
          fScore.set(to, tentative + h);
          if (!openSet.has(to)) {
            open.push(to);
            openSet.add(to);
          }
        }
      }
    }
    return null;
  }

  /** P1-SCHED-003：从 versioned policy 刷新边代价系数（失败时保留上次值，绝不阻断路由）。NEST-133：TTL 缓存。 */
  private async refreshEdgeFactors(force = false): Promise<void> {
    if (
      !force &&
      this.edgeFactors != null &&
      Date.now() - this.edgeFactorsRefreshedAt <
        RoutingService.EDGE_FACTORS_TTL_MS
    ) {
      return; // TTL 内复用缓存（NEST-133：消除逐路由计算的 policy N+1 读）
    }
    try {
      const config = this.policyService
        ? await this.policyService.getConfig()
        : undefined;
      if (!config) return;
      this.edgeFactors = {
        congestedFactor:
          typeof config.congestedFactor === 'number' && config.congestedFactor > 0
            ? config.congestedFactor
            : 1.5,
        blockedFactor:
          typeof config.blockedFactor === 'number' && config.blockedFactor > 0
            ? config.blockedFactor
            : 2,
        highRiskFactor:
          typeof config.highRiskFactor === 'number' && config.highRiskFactor > 0
            ? config.highRiskFactor
            : 2,
        mediumRiskFactor:
          typeof config.mediumRiskFactor === 'number' && config.mediumRiskFactor > 0
            ? config.mediumRiskFactor
            : 1.3,
      };
      this.edgeFactorsRefreshedAt = Date.now();
    } catch (err) {
      this.logger.warn(
        `policy route factors unavailable, using cached: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 边代价 = 距离 × 拥塞系数 × 风险系数（系数来自 versioned policy，P1-SCHED-003）。 */
  private edgeCost(edge: RouteGraphEdge): number {
    const f = this.edgeFactors ?? {
      congestedFactor: 1.5,
      blockedFactor: 2,
      highRiskFactor: 2,
      mediumRiskFactor: 1.3,
    };
    const congestion =
      edge.status === 'congested'
        ? f.congestedFactor
        : edge.status === 'open'
          ? 1
          : f.blockedFactor;
    const risk =
      edge.riskLevel === 'high'
        ? f.highRiskFactor
        : edge.riskLevel === 'medium'
          ? f.mediumRiskFactor
          : 1;
    return Math.max(edge.distanceMeters, 1) * congestion * risk;
  }

  private heuristic(a: GraphNode, b: GraphNode): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  private reconstructPath(cameFrom: Map<string, string>, current: string): string[] {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      path.unshift(current);
    }
    return path;
  }

  private pathDistance(graph: RouteGraph, path: string[]): number {
    const edgeByKey = new Map<string, RouteGraphEdge>();
    for (const e of graph.edges) {
      edgeByKey.set(`${e.fromNodeId}->${e.toNodeId}`, e);
    }
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = edgeByKey.get(`${path[i]}->${path[i + 1]}`);
      total += edge ? edge.distanceMeters : 1;
    }
    return total;
  }

  private pathTime(graph: RouteGraph, path: string[]): number {
    const edgeByKey = new Map<string, RouteGraphEdge>();
    for (const e of graph.edges) {
      edgeByKey.set(`${e.fromNodeId}->${e.toNodeId}`, e);
    }
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = edgeByKey.get(`${path[i]}->${path[i + 1]}`);
      total += edge ? (edge.expectedTimeSeconds ?? edge.distanceMeters) : 1;
    }
    return total;
  }
}