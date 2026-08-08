import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { ewohRouteNode, ewohRouteEdge, ewohSpatialEntity } from '@server/database/schema';
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

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /** 加载完整路由图。 */
  async loadGraph(): Promise<RouteGraph> {
    const [nodeRows, edgeRows] = await Promise.all([
      this.db.select().from(ewohRouteNode),
      this.db.select().from(ewohRouteEdge),
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
   * feasible 由 from/to 坐标是否齐全决定。从不抛异常。
   */
  async calculateRouteBetween(
    from: Point,
    to: Point,
    meta?: { personId?: string; taskId?: string },
  ): Promise<Route> {
    const graph = await this.loadGraph();
    const nodes = graph.nodes.map((n) => ({
      nodeId: n.nodeId,
      x: n.x,
      y: n.y,
    }));
    const personId = meta?.personId ?? 'unknown';
    const taskId = meta?.taskId ?? 'unknown';
    const hasCoords =
      Number.isFinite(from.x) &&
      Number.isFinite(from.y) &&
      Number.isFinite(to.x) &&
      Number.isFinite(to.y);
    const fallback = await this.euclideanRoute(from, to, {
      personId,
      taskId,
      feasible: hasCoords,
    });

    const startId = nearestNodeId(nodes, from.x, from.y);
    const goalId = nearestNodeId(nodes, to.x, to.y);
    if (!startId || !goalId || startId === goalId) return fallback;

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
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      feasible: true,
    };
  }

  /**
   * 为人员到任务工位规划一条路径（按 entityId 查真实坐标）。
   * 从 ewoh_spatial_entity 取 person/task 的 x/y，再求最近节点；
   * 查不到坐标或不可达时按 euclidean_fallback 处理。
   */
  async calculateRoute(personId: string, taskId: string): Promise<Route> {
    const [personRows, taskRows] = await Promise.all([
      this.db
        .select()
        .from(ewohSpatialEntity)
        .where(eq(ewohSpatialEntity.entityId, personId))
        .limit(1),
      this.db
        .select()
        .from(ewohSpatialEntity)
        .where(eq(ewohSpatialEntity.entityId, taskId))
        .limit(1),
    ]);
    const from = this.pointFromEntity(personRows[0]);
    const to = this.pointFromEntity(taskRows[0]);
    if (!from || !to) {
      return this.euclideanRoute(from ?? { x: 0, y: 0 }, to ?? { x: 0, y: 0 }, {
        personId,
        taskId,
        feasible: Boolean(from) && Boolean(to),
      });
    }
    return this.calculateRouteBetween(from, to, { personId, taskId });
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

  /** 构造欧氏兜底 Route（不抛异常）。P1-ROUTE-001：ETA 必须由距离/速度计算，禁止返回 0。 */
  private async euclideanRoute(
    from: Point,
    to: Point,
    meta: { personId: string; taskId: string; feasible: boolean },
  ): Promise<Route> {
    const distanceMeters = Math.hypot(to.x - from.x, to.y - from.y);
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
          if (!open.includes(to)) open.push(to);
        }
      }
    }
    return null;
  }

  /** 边代价 = 距离 × 拥塞系数 × 风险系数。 */
  private edgeCost(edge: RouteGraphEdge): number {
    const congestion =
      edge.status === 'congested' ? 1.5 : edge.status === 'open' ? 1 : 2;
    const risk =
      edge.riskLevel === 'high'
        ? 2
        : edge.riskLevel === 'medium'
          ? 1.3
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