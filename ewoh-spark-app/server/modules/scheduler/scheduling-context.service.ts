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
 * - snapshotVersion：buildSnapshotReadOnly 读取最近一次持久化快照版本
 *   （读轮询不推进世界版本——只有调度 run 才产生新快照；2026-08-19 优化，
 *   原每次轮询 buildSnapshot 分配版本号 + INSERT 是 context 偶发数秒峰值来源）；
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

  /** context 短缓存 TTL（与前端 30s 轮询同频——命中率≈100%，重建降至每 30s 一次，
   *  大幅降低磁盘 IO 饱和环境下的读侧开销；调度 run 成功后显式失效保证即时性）。 */
  private static readonly CONTEXT_CACHE_TTL_MS = 30_000;

  /** org 维度短缓存（调度 run 成功后显式失效，保证"触发调度→新版本"即时可见）。 */
  private readonly contextCache = new Map<
    string,
    { expiresAt: number; value: SchedulingContextResponse }
  >();

  constructor(
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly resourceProjectionService: ResourceProjectionService,
    private readonly policyService: SchedulingPolicyService,
    private readonly outboxService: OutboxService,
    private readonly constraintLoaderService: ConstraintLoaderService,
  ) {}

  /** 失效指定 org（或全部）的 context 缓存——调度 run 成功后调用。 */
  invalidate(orgId?: string): void {
    if (orgId) {
      this.contextCache.delete(orgId);
      this.contextCache.delete(orgId || 'system');
    } else {
      this.contextCache.clear();
    }
    this.logger.debug(`context cache invalidated${orgId ? ` for org ${orgId}` : ''}`);
  }

  async getContext(ctx?: OrgContext): Promise<SchedulingContextResponse> {
    const orgCtx = this.toOrgContext(ctx);
    const cacheKey = orgCtx.primaryOrgId || 'system';

    const cached = this.contextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return this.cloneContext(cached.value);
    }

    const context = await this.buildContext(orgCtx);
    this.contextCache.set(cacheKey, {
      expiresAt: Date.now() + SchedulingContextService.CONTEXT_CACHE_TTL_MS,
      value: context,
    });
    return this.cloneContext(context);
  }

  /** 浅拷贝返回（防调用方修改污染缓存；数组层复制，内部对象只读消费）。 */
  private cloneContext(value: SchedulingContextResponse): SchedulingContextResponse {
    return {
      ...value,
      tasks: [...value.tasks],
      resources: [...value.resources],
      reservations: value.reservations ? [...value.reservations] : value.reservations,
      constraints: [...value.constraints],
      dataQuality: { ...value.dataQuality },
    };
  }

  /** 真实构建（7 表快照 + 资源投影 + 策略 + outbox + 约束，同一时间切片并行取回）。 */
  private async buildContext(orgCtx: OrgContext): Promise<SchedulingContextResponse> {
    // 先构建快照（确定 snapshotVersion / ts / worldVersion），
    // 其余来源与快照处于同一时间切片并行取回（同一请求窗口，非跨切片拼装）。
    // 性能优化（2026-08-19）：context 是高频读轮询，用只读构建（不分配版本号、
    // 不 INSERT 快照）——原 buildSnapshot 每次调用都计数器行锁 + 落库，是
    // 偶发数秒峰值的来源。调度写路径（run/事件/方案）仍走 buildSnapshot。
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(orgCtx);
    const [resources, policy, eventSequence, constraints] = await Promise.all([
      // 统一资源投影（与 GET /api/scheduler/resources/state 同源，SSOT）。
      // NEST-109（2026-08-17）：资源投影透传 ctx（与快照同一 org 时间切片，
      // 消除跨租户资源混入 context.resources）。
      this.resourceProjectionService.getUnifiedResourceState(orgCtx),
      this.policyService.getActivePolicy(orgCtx.primaryOrgId || undefined),
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
    // 'normal' 与 'open' 均为健康状态（此前仅排除 'open'，'normal' 边全部被
    // 误计为降级 → 前端恒显示"全部路由降级"误报）。
    const degradedRouteCount = (snapshot.routeStatus ?? []).filter(
      (r) => r.status !== 'open' && r.status !== 'normal',
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
