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
   * 优先走 route graph；失败时按欧氏距离兜底。
   */
  async estimate(
    personId: string,
    taskId: string,
    from?: Point,
    to?: Point,
  ): Promise<RouteCost> {
    try {
      const route = await this.routingService.calculateRoute(personId, taskId);
      return {
        routeId: route.routeId,
        distanceMeters: route.distanceMeters,
        etaSeconds: route.etaSeconds,
        riskLevel: this.riskOf(route),
        feasible: true,
      };
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

  /** 欧氏距离估算；坐标缺失时返回不可行。 */
  private async euclidean(from?: Point, to?: Point): Promise<RouteCost> {
    if (!from || !to) {
      return {
        routeId: null,
        distanceMeters: 0,
        etaSeconds: 0,
        riskLevel: null,
        feasible: false,
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
    };
  }

  /** 安全读取 route graph 上的风险等级（旧版 Route 可能不含该字段）。 */
  private riskOf(route: Route): string | null {
    return (route as Route & { riskLevel?: string | null }).riskLevel ?? null;
  }
}