import { Injectable, Logger } from '@nestjs/common';
import type {
  SchedulingContext,
  SchedulingContextResponse,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { ResourceProjectionService } from './resource-projection.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { OutboxService } from './outbox.service';
import { ConstraintLoaderService } from './constraint-loader.service';

/**
 * P0-2：统一调度上下文服务（GET /api/scheduler/context）。
 *
 * 在单一 org 时间切片下组装 SchedulingContext：所有来源复用既有服务的
 * org 过滤语义（buildSnapshot / loadGlobalActive 按 ctx 过滤；资源投影与
 * outbox sequence 为全局事实，应用层不做二次过滤）。
 *
 * 版本字段真实取值，禁止伪造（各字段来源见 shared/scheduler.ts SchedulingContext 注释）：
 * - snapshotVersion：buildSnapshot 持久化快照版本；
 * - resourceVersion / routeGraphVersion：snapshot.worldVersion 字符串化
 *   （资源投影与路由图均无独立版本号，与 TravelCostService.routeGraphVersionOf
 *   （travel-cost.service.ts:471）同源：以全局单调递增 worldVersion 作代理）；
 * - policyVersion：getActivePolicy().version；
 * - eventSequence：outbox.latestSequence()（全局 sequence，与 SSE Last-Event-ID 同源）；
 * - sourceTimestamp：snapshot.ts。
 */
@Injectable()
export class SchedulingContextService {
  private readonly logger = new Logger(SchedulingContextService.name);

  constructor(
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly resourceProjectionService: ResourceProjectionService,
    private readonly policyService: SchedulingPolicyService,
    private readonly outboxService: OutboxService,
    private readonly constraintLoaderService: ConstraintLoaderService,
  ) {}

  async getContext(ctx?: OrgContext): Promise<SchedulingContextResponse> {
    const orgCtx = this.toOrgContext(ctx);

    // 先构建快照（确定 snapshotVersion / ts / worldVersion），
    // 其余来源与快照处于同一时间切片并行取回（同一请求窗口，非跨切片拼装）。
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(orgCtx);
    const [resources, policy, eventSequence, constraints] = await Promise.all([
      // 统一资源投影（与 GET /api/scheduler/resources/state 同源，SSOT）。
      this.resourceProjectionService.getUnifiedResourceState(),
      this.policyService.getActivePolicy(),
      this.outboxService.latestSequence(),
      this.constraintLoaderService.loadGlobalActive(orgCtx),
    ]);

    // 版本字段：resource 投影 / 路由图与 snapshot 同一世界版本（无独立版本号，
    // 以 worldVersion 字符串化，注释见文件头；禁止伪造独立版本号）。
    const versionProxy = String(snapshot.worldVersion);

    // dataQuality 汇总（全部来自真实统计，可审计；缺数据不虚构）。
    const staleResourceCount = resources.filter(
      (r) => r.dataQuality === 'STALE',
    ).length;
    const unknownLocationCount = resources.filter((r) => {
      const loc = r.location;
      return loc.x == null && loc.y == null && loc.stationId == null;
    }).length;
    const degradedRouteCount = (snapshot.routeStatus ?? []).filter(
      (r) => r.status !== 'open',
    ).length;

    const context: SchedulingContext = {
      snapshotVersion: snapshot.snapshotVersion,
      resourceVersion: versionProxy,
      routeGraphVersion: versionProxy,
      policyVersion: policy.version,
      eventSequence,
      sourceTimestamp: snapshot.ts,
      tasks: snapshot.tasks,
      resources,
      reservations: snapshot.reservations,
      constraints,
      dataQuality: {
        staleResourceCount,
        unknownLocationCount,
        degradedRouteCount,
        totalResources: resources.length,
      },
    };

    this.logger.debug(
      `scheduling context: snapshot=${context.snapshotVersion} resources=${context.dataQuality.totalResources} constraints=${constraints.length}`,
    );
    return context;
  }

  /** 归一化 org 上下文（缺省时与 SchedulerService.toOrgContext 语义一致）。 */
  private toOrgContext(actor?: OrgContext): OrgContext {
    return {
      userId: actor?.userId ?? 'system',
      primaryOrgId: actor?.primaryOrgId ?? '',
      role: actor?.role,
      accessibleOrgIds:
        actor?.accessibleOrgIds ??
        (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
      isGlobalAdmin: actor?.isGlobalAdmin ?? false,
    };
  }
}
