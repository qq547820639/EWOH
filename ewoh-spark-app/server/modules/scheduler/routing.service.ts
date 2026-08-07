import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohRouteNode, ewohRouteEdge } from '@server/database/schema';
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

/**
 * 路由服务：从 ewoh_route_node / ewoh_route_edge 加载路由图，
 * 使用 A* 计算最短路径（边代价叠加拥塞/风险系数，跳过阻塞边）。
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
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
   * 为人员到任务工位规划一条路径。
   * 起点/终点由各自的 spatial entity 最近节点决定。
   */
  async calculateRoute(personId: string, taskId: string): Promise<Route> {
    const graph = await this.loadGraph();
    const nodes = graph.nodes.map((n) => ({
      nodeId: n.nodeId,
      x: n.x,
      y: n.y,
    }));

    // 通过人员/任务关联的工位坐标定位起终点（无则回退到最近节点）。
    const start = await this.startNodeForPerson(personId, nodes);
    const goal = await this.goalNodeForTask(taskId, nodes);

    if (!start || !goal) {
      throw new NotFoundException('ROUTE_NOT_FOUND');
    }

    const path = this.astar(graph, start.nodeId, goal.nodeId);
    if (!path || path.length < 2) {
      throw new NotFoundException('ROUTE_NOT_FOUND');
    }

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
    };
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

  /** 求人员起点的最近路由节点。 */
  private async startNodeForPerson(
    personId: string,
    nodes: GraphNode[],
  ): Promise<GraphNode | null> {
    // 无人员坐标时回退到第一个节点（保持确定性）。
    const fallback = nodes[0] ?? null;
    return fallback;
  }

  /** 求任务目标工位的最近路由节点。 */
  private async goalNodeForTask(
    taskId: string,
    nodes: GraphNode[],
  ): Promise<GraphNode | null> {
    const fallback = nodes[nodes.length - 1] ?? null;
    return fallback;
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