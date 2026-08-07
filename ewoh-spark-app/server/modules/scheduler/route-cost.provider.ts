import { Injectable, Logger } from '@nestjs/common';
import type { Route } from '@shared/api.interface';
import { RoutingService } from './routing.service';
import { SchedulingPolicyService } from './scheduling-policy.service';

/** 统一路径成本结果。 */
export interface RouteCost {
  routeId: string | null; // 非空表示使用真实 route graph
  distanceMeters: number;
  etaSeconds: number;
  riskLevel: string | null;
  feasible: boolean; // route graph 与欧氏兜底均不可行时为 false
  /** 成本来源：route_graph 或 euclidean_fallback。 */
  source: 'route_graph' | 'euclidean_fallback';
  /** 沿路风险成本（由 riskLevel 折算）。 */
  riskCost: number;
  /** 拥塞成本（route graph 无拥塞明细信息时默认 0）。 */
  congestionCost: number;
  /** 计算所用路由图版本。 */
  graphVersion: number | null;
  /** 计算时间（ISO）。 */
  calculatedAt: string;
}

/** 坐标点。 */
interface Point {
  x: number;
  y: number;
}

/**
 * 路径成本提供者：统一 walking/movement 成本来源。
 * 优先使用与地图展示一致的 route graph（RoutingService），
 * 仅在无可直达 route 边时回退到确定性欧氏距离。
 */
@Injectable()
export class RouteCostProvider {
  private readonly logger = new Logger(RouteCostProvider.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly policy: SchedulingPolicyService,
  ) {}

  /**
   * 估算人员到任务工位的路径成本。
   * 有 from/to 坐标时优先走 calculateRouteBetween（真实不同路线）；
   * 否则走 calculateRoute（内部查 spatial entity 坐标，失败则欧氏兜底）。
   * route graph 不可行时显式回退到欧氏并以 source 标记。
   */
  async estimate(
    personId: string,
    taskId: string,
    from?: Point,
    to?: Point,
  ): Promise<RouteCost> {
    if (from && to && this.hasCoord(from) && this.hasCoord(to)) {
      const route = await this.routingService.calculateRouteBetween(from, to, {
        personId,
        taskId,
      });
      if (route.feasible && route.source === 'route_graph') {
        return this.fromRoute(route);
      }
      return this.euclidean(from, to);
    }

    // 无坐标：尝试通过 spatial entity 解析真实起终点。
    try {
      const route = await this.routingService.calculateRoute(personId, taskId);
      if (route.feasible && route.source === 'route_graph') {
        return this.fromRoute(route);
      }
      return this.euclidean(from, to);
    } catch (err) {
      this.logger.warn(
        `Route graph unavailable for person=${personId} task=${taskId}, falling back to euclidean: ${(err as Error)?.message ?? err}`,
      );
      return this.euclidean(from, to);
    }
  }

  /**
   * 纯欧氏距离兜底（无 person/task id 可用时）。
   */
  async estimateBetween(
    stationA?: Point,
    stationB?: Point,
  ): Promise<RouteCost> {
    return this.euclidean(stationA, stationB);
  }

  /** 将 route graph 的 Route 转换为 RouteCost。 */
  private fromRoute(route: Route): RouteCost {
    return {
      routeId: route.routeId,
      distanceMeters: route.distanceMeters,
      etaSeconds: route.etaSeconds,
      riskLevel: route.riskLevel ?? null,
      feasible: true,
      source: 'route_graph',
      riskCost: this.riskToCost(route.riskLevel ?? null),
      congestionCost: 0,
      graphVersion: route.graphVersion ?? null,
      calculatedAt: route.calculatedAt ?? new Date().toISOString(),
    };
  }

  /** 欧氏距离估算；坐标缺失时返回不可行。 */
  private async euclidean(from?: Point, to?: Point): Promise<RouteCost> {
    if (!from || !to) {
      return {
        routeId: null,
        distanceMeters: 0,
        etaSeconds: 0,
        riskLevel: null,
        feasible: false,
        source: 'euclidean_fallback',
        riskCost: 0,
        congestionCost: 0,
        graphVersion: null,
        calculatedAt: new Date().toISOString(),
      };
    }
    const config = await this.policy.getConfig();
    const speed = config.walkingSpeedMps;
    const distanceMeters = Math.hypot(to.x - from.x, to.y - from.y);
    const etaSeconds = speed > 0 ? distanceMeters / speed : 0;
    return {
      routeId: null,
      distanceMeters,
      etaSeconds,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
    };
  }

  private hasCoord(p: Point): boolean {
    return Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  private riskToCost(riskLevel: string | null): number {
    if (riskLevel === 'high') return 2;
    if (riskLevel === 'medium') return 1.3;
    return 1;
  }
}