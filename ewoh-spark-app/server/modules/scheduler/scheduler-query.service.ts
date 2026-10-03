/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SchedulerService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
/**
 * SchedulerService Strangler Refactor（Task 2）：只读查询面。
 *
 * 承载原 scheduler.service.ts 的全部 read-only 方法：方案/运行/审计/快照查询、
 * 策略版本查询与只读对比、路由计算、任务候选、冲突聚合（含未注入 ConflictService
 * 时的内存推导回退）、方案约束查询与执行领域查询。
 *
 * 不含任何写路径（confirm/reject/approve/dispatch/replan/override/event 等均在
 * 各自的 application service 中）。
 */
import {
  Injectable,
  Inject,
  Logger,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { currentRequestContext } from '../../common/request-context';
import { normalizeBatteryPct } from '@shared/scheduler';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohSchedulingRun,
} from '@server/database/schema';
import { eq, desc, and, sql, gte, lte, inArray, or, isNull, type SQL } from 'drizzle-orm';
import type {
  SchedulePlan,
  ScheduleAudit,
  SchedulingPlanV2,
  SchedulingRun,
  RouteGraph,
  Route,
  ListRunsRequest,
  ListRunsResponse,
  WorldStateSnapshot,
  SchedulingConflict,
  ConflictsListRequest,
  ConflictsListResponse,
  SchedulingPolicyConfig,
  SchedulingPolicy,
  SchedulingPolicyVersionSummary,
  SchedulingPolicyComparison,
  CalculateRouteRequest,
  RouteCandidateCost,
  RouteCandidatesResponse,
  TaskCandidatesResponse,
  TaskCandidateResource,
  ExecutionListResponse,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from './plan-tenant-guard';
import { WorldStateSnapshotService } from './world-state.service';
import { PlanService } from './plan.service';
import { RoutingService } from './routing.service';
import { EligibilityService } from './eligibility.service';
import { RouteCostProvider } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { ConflictService } from './conflict.service';
import { PolicyReplayService } from './policy-replay.service';
import { ExecutionService } from './execution.service';
import { CandidateEngineService } from './candidate-engine.service';
import { TaskLifecycle } from './task-lifecycle';
import { toOrgContext, mapPlan, mapAudit } from './scheduler-run-context';

@Injectable()
export class SchedulerQueryService {
  private readonly logger = new Logger(SchedulerQueryService.name);

  /** 视为"活跃"（非终态）的方案状态，用于列出当前待处理/已批准的方案。 */
  private static readonly ACTIVE_PLAN_STATUSES = [
    'draft',
    'shadow',
    'proposed',
    'approved',
    'dispatched',
    'executing',
  ];

  /**
   * 活跃方案读面的 **strategy 白名单**（真实调度方案才进入前端"活跃方案"列表）。
   *
   * 背景：`ewoh_schedule_plan` 是**多域共用表**。gamification 模块绕过调度内核直写该表
   * （`gamification.service.ts` 的 `resource_alloc` / `task_orchest`，均 status='proposed'），
   * 而本方法原先只按 status 过滤，导致非调度方案混入活跃调度方案列表。
   *
   * 为何按 strategy 白名单而非排除 `resource_alloc`/`task_orchest`：排除法只能挡住
   * 现存两种非调度策略，将来新增第三种会再次漏网；白名单天然免疫。
   *
   * 为何**不是**求解器版本名（heuristic-v2 / cpsat-v1 / rule-based-v1 / milp-v1）：
   * 求解器身份持久化在 `solver_version` 列，而 `strategy` 列由唯一真实调度写入口
   * `PlanService.persistPlan` 硬编码为 `'scheduling_v2'`（plan.service.ts:131）——
   * 跑哪个求解器都写同一个值。若把求解器版本名当白名单，会把全部真实调度方案过滤掉。
   *
   * 取值依据：
   * - `scheduling_v2`：当前唯一调度写入口（plan.service.ts:131）。
   * - `keep_status` / `capacity_priority` / `load_balance`：调度域自身的历史真实策略值
   *   （旧 scheduler.service.ts 写入点；`shared/scheduler.ts` 的 `ScheduleStrategy`
   *   联合类型；openapi/ewoh.yaml 的 strategy 字段说明）。保留它们，历史遗留的真实
   *   调度方案才不会从活跃列表消失。
   *
   * fail-open：未知 strategy 只是被过滤，不抛错（不因历史脏数据让合法请求 500）。
   */
  private static readonly SCHEDULING_PLAN_STRATEGIES = [
    'scheduling_v2',
    'keep_status',
    'capacity_priority',
    'load_balance',
  ];

  /** v0.7 A2：预占过期预警阈值（ms），剩余时长低于该值产出 reservation_expiring 冲突。默认 15 分钟。 */
  private readonly reservationExpiringThresholdMs = 15 * 60 * 1000;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly planService: PlanService,
    private readonly routingService: RoutingService,
    private readonly policyService: SchedulingPolicyService,
    private readonly feedbackService: SchedulingFeedbackService,
    private readonly eligibilityService: EligibilityService,
    private readonly routeCostProvider: RouteCostProvider,
    // T03 / P1-2（G7）：候选引擎（可选注入；注入后 getTaskCandidates 委托富化响应）。
    private readonly candidateEngineService?: CandidateEngineService,
    // Phase 3 / P3-T1：冲突生命周期服务（可选注入；未注入回退本服务内存推导）。
    private readonly conflictService?: ConflictService,
    // Phase 4 / P4-T2：Shadow Policy 真实 replay（可选注入；未注入 compare 回退 delta 估算）。
    private readonly policyReplayService?: PolicyReplayService,
    // Phase 4 / P4-EXEC：执行领域查询（可选注入；未注入时抛错）。
    private readonly executionService?: ExecutionService,
  ) {}

  /**
   * NEST-110 修复（2026-08-17）：HTTP 请求上下文内 actor 必传——无 actor 的
   * 读请求（controller 忘传 userContext / 中间层吞掉）一律 401 fail-closed，
   * 杜绝「无 actor 即全表」跨租户路径；系统后台流（无 request context）与
   * 函数式测试（无 request context）保持 GUC/RLS 兜底语义。
   * getPlans/getAudit/getActivePlans/getSnapshot 同口径。
   */
  private assertActorForHttp(actor: OrgContext | undefined): void {
    if (!actor && currentRequestContext()) {
      throw new UnauthorizedException(
        'org context required for scheduler read（NEST-110：HTTP 读路径必须携带认证上下文）',
      );
    }
  }

  async getPlans(status?: string, actor?: OrgContext): Promise<SchedulePlan[]> {
    try {
      this.assertActorForHttp(actor);
      const conditions = status ? [eq(ewohSchedulePlan.status, status)] : [];
      // ADR-071 / NEST-110：actor 提供时按 org 过滤（org 匹配或 NULL 存量行）。
      if (actor) {
        conditions.push(
          or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, actor.primaryOrgId)),
        );
      }
      const rows = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohSchedulePlan.createdAt))
        .limit(50);
      return rows.map((r) => mapPlan(r));
    } catch (error) {
      this.logger.error('getPlans 失败', error);
      throw error;
    }
  }

  async getAudit(planId?: string, actor?: OrgContext): Promise<ScheduleAudit[]> {
    try {
      this.assertActorForHttp(actor);
      const conditions = planId ? [eq(ewohScheduleAudit.planId, planId)] : [];
      // ADR-072：audit 表无 org 列/RLS——归属经父方案事实推导过滤
      // （planId ∈ 本租户可见方案：org 匹配或 NULL 存量），§3 单一事实源。
      if (actor) {
        conditions.push(
          inArray(
            ewohScheduleAudit.planId,
            this.db
              .select({ planId: ewohSchedulePlan.planId })
              .from(ewohSchedulePlan)
              .where(
                or(
                  isNull(ewohSchedulePlan.orgId),
                  eq(ewohSchedulePlan.orgId, actor.primaryOrgId),
                ),
              ),
          ),
        );
      }
      const rows = await this.db
        .select()
        .from(ewohScheduleAudit)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohScheduleAudit.createdAt))
        .limit(100);
      return rows.map((r) => mapAudit(r));
    } catch (error) {
      this.logger.error('getAudit 失败', error);
      throw error;
    }
  }

  async getRun(runId: string, actor?: OrgContext): Promise<SchedulingRun | null> {
    // getRun is also an HTTP read face; the detail path must not rely only on
    // assertTenantVisible after a cross-tenant row has already been selected.
    this.assertActorForHttp(actor);
    const [row] = await this.db
      .select()
      .from(ewohSchedulingRun)
      .where(eq(ewohSchedulingRun.runId, runId))
      .limit(1);
    if (!row) return null;
    // ADR-072：run 读面守卫（NULL 存量放行、跨租户 404；与 RLS 语义等价）。
    assertTenantVisible(row.orgId, actor, `Run ${runId}`);
    return this.mapRun(row);
  }

  /**
   * 分页查询调度运行历史 + 返回当前活跃方案列表。
   * - runs：按过滤器（status / from / to）分页的 SchedulingRun 记录；
   * - plans：状态为非终态的活跃方案（proposed/shadow/draft/approved/dispatched/executing）；
   * - total：满足过滤条件的运行总条数（用于分页）。
   * 复用现有 db（drizzle）与 planService.getPlan，不引入并行调度器。
   */
  async listRuns(params: ListRunsRequest = {}, actor?: OrgContext): Promise<ListRunsResponse> {
    // Lists are the highest-volume read path: never fall back to an unscoped
    // query when an authenticated HTTP request failed to carry its org context.
    this.assertActorForHttp(actor);
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));

    const conditions: SQL[] = [];
    if (params.status) {
      conditions.push(eq(ewohSchedulingRun.status, params.status));
    }
    if (params.from && !Number.isNaN(Date.parse(params.from))) {
      conditions.push(gte(ewohSchedulingRun.createdAt, new Date(params.from)));
    }
    if (params.to && !Number.isNaN(Date.parse(params.to))) {
      conditions.push(lte(ewohSchedulingRun.createdAt, new Date(params.to)));
    }
    // Batch 8 RLS 缓解：应用层 org 过滤补强（ewohSchedulingRun 有 org_id 列但不在 RLS 白名单）。
    // actor 携带 primaryOrgId 时按 org 过滤（与写路径 GUC 语义一致）；缺省不过滤（向后兼容）。
    const orgFilter = actor?.primaryOrgId
      ? eq(ewohSchedulingRun.orgId, actor.primaryOrgId)
      : undefined;
    if (orgFilter) conditions.push(orgFilter);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRows, runRows, activePlanRows] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ewohSchedulingRun)
        .where(whereClause),
      this.db
        .select()
        .from(ewohSchedulingRun)
        .where(whereClause)
        .orderBy(desc(ewohSchedulingRun.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select()
        .from(ewohSchedulePlan)
        .where(
          and(
            inArray(ewohSchedulePlan.status, SchedulerQueryService.ACTIVE_PLAN_STATUSES),
            // NEST-106（2026-08-17）：活跃方案聚合同口径 org 过滤
            // （org 匹配或 NULL 存量），消除跨租户方案混入 listRuns 响应。
            actor
              ? or(
                  isNull(ewohSchedulePlan.orgId),
                  eq(ewohSchedulePlan.orgId, actor.primaryOrgId),
                )
              : undefined,
          ),
        )
        .orderBy(desc(ewohSchedulePlan.createdAt)),
    ]);

    const runs = runRows.map((r) => this.mapRun(r));
    // R-5 N+1 修复：活跃方案批量加载（原逐方案 getPlan → 每方案 2 次查询）。
    // slim=true：列表接口剥离 decisionTrace/alternatives/scoreBreakdown 等重量级
    // 字段（90 方案 × 16 分配 × 36KB ≈ 50MB 响应 → 47-60s），前端按需 GET /plans/:planId。
    const plans = await this.planService.listPlansBatched(
      activePlanRows.map((p) => p.planId),
      { slim: true },
    );

    return {
      runs,
      plans,
      total: countRows[0]?.count ?? 0,
      page,
      pageSize,
    };
  }

  /**
   * P0-1 Active Plan 权威查询：返回当前所有非终态方案（shadow/proposed/
   * draft/approved/dispatched/executing），按创建时间倒序。
   *
   * 前端页面刷新 / SSE resync / 多终端必须从此处重新拉取权威方案，
   * SSE 仅作为增量更新机制，不作为唯一状态源。
   *
   * strategy 域隔离：仅返回真实调度方案（SCHEDULING_PLAN_STRATEGIES 白名单），
   * 排除共用表里 gamification 等其他域写入的非调度方案。
   */
  async getActivePlans(actor?: OrgContext): Promise<SchedulingPlanV2[]> {
    this.assertActorForHttp(actor);
    const conditions: SQL[] = [
      inArray(ewohSchedulePlan.status, SchedulerQueryService.ACTIVE_PLAN_STATUSES),
      // ewoh_schedule_plan 为多域共用表：按 strategy 白名单收敛到调度域，
      // 使非调度方案（gamification resource_alloc / task_orchest）不进入本列表。
      inArray(ewohSchedulePlan.strategy, SchedulerQueryService.SCHEDULING_PLAN_STRATEGIES),
    ];
    // ADR-071：actor 提供时按 org 过滤（org 匹配或 NULL 存量行——与 RLS USING 等价）。
    if (actor) {
      conditions.push(
        or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, actor.primaryOrgId)),
      );
    }
    const rows = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(and(...conditions))
      .orderBy(desc(ewohSchedulePlan.createdAt));
    // R-5 N+1 修复：批量加载（保留 per-plan 失败跳过语义——listPlansBatched 内部跳过损坏方案）。
    // slim=true：列表场景剥离重量级字段（同 listRuns）。
    return this.planService.listPlansBatched(rows.map((p) => p.planId), { slim: true });
  }

  /**
   * 返回 map 与调度共享的当前权威世界状态快照。
   * 复用 WorldStateSnapshotService.getCurrentWorldState() 的真实当前状态（不持久化、不虚构），
   * 以 snapshotVersion='CURRENT' + 当前 ts 包装为 WorldStateSnapshot。
   */
  async getSnapshot(actor?: OrgContext): Promise<WorldStateSnapshot> {
    this.assertActorForHttp(actor);
    // NEST-101/111：世界状态收集透传 ctx（7 表 org 过滤）。
    const state = await this.worldStateSnapshotService.getCurrentWorldState(actor);
    return {
      ...state,
      snapshotVersion: 'CURRENT',
      ts: new Date().toISOString(),
    };
  }

  async getPlanDetail(planId: string, actor?: OrgContext): Promise<SchedulingPlanV2> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp（NEST-110 覆盖面补全）。
    this.assertActorForHttp(actor);
    return this.planService.getPlan(planId, actor);
  }

  // ===== SchedulingPolicy versioning (Task 6: 命令图调度闭环) =====

  /** 返回当前生效策略 + 配置（只读）。NEST-105：actor org 过滤。 */
  async getPolicy(actor?: OrgContext): Promise<{ policy: SchedulingPolicy; config: SchedulingPolicyConfig }> {
    this.assertActorForHttp(actor);
    const orgId = actor?.primaryOrgId || null;
    const [policy, config] = await Promise.all([
      this.policyService.getActivePolicy(orgId),
      this.policyService.getConfig(orgId),
    ]);
    return { policy, config };
  }

  /** 列出全部策略版本（含 active 标志、操作人、创建时间）。R2-SSV-07：HTTP 守卫。 */
  async listPolicyVersions(actor?: OrgContext): Promise<SchedulingPolicyVersionSummary[]> {
    this.assertActorForHttp(actor);
    // ADR-073：policy versions 读面 org 条件（org 匹配或 NULL 存量）。
    return this.policyService.listVersions(actor?.primaryOrgId ?? null);
  }

  /**
   * shadow/只读对比：候选版本 vs 当前生效版本。
   * Phase 4 / P4-T2：优先以历史 snapshot 真实 replay（active vs candidate 双策略求解，
   * 对比 objective/KPI，结果附加于 comparison.replay）；无历史快照时回退
   * param delta + 估算。绝不激活任何版本。
   */
  async comparePolicyVersion(
    configVersion: number,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyComparison> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp。
    this.assertActorForHttp(actor);
    const ctx = toOrgContext(actor);
    const [activeConfig, candidateConfig, feedbackKpis] = await Promise.all([
      // NEST-105：生效配置按 actor org 过滤（跨租户策略不进入对比基线）。
      this.policyService.getConfig(ctx.primaryOrgId || null),
      // R2-SSV-01 配套：候选配置同样按 org 过滤（configVersion 按 org 作用域
      // 递增，仅凭版本号会取到他租户候选策略）。
      this.policyService.getConfigByVersion(configVersion, ctx.primaryOrgId || null),
      // ADR-073：对比 KPI 按本租户反馈派生（跨租户聚合关闭）。
      this.feedbackService.deriveKpis(ctx.primaryOrgId || null),
    ]);
    if (!candidateConfig) {
      throw new NotFoundException(
        `Scheduling policy version ${configVersion} not found`,
      );
    }
    const paramDeltas = this.buildConfigParamDeltas(activeConfig, candidateConfig);
    const comparison: SchedulingPolicyComparison = {
      candidateVersion: configVersion,
      activeVersion: activeConfig.configVersion,
      feedbackKpis,
      paramDeltas,
      objective: this.estimateObjective(activeConfig, candidateConfig),
      verdict: this.buildVerdict(paramDeltas),
      readOnly: true,
    };
    // Phase 4 / P4-T2：真实 replay（失败仅记日志，不阻断旧评估路径）。
    if (this.policyReplayService) {
      try {
        comparison.replay = await this.policyReplayService.evaluate(
          configVersion,
          ctx,
        );
      } catch (err) {
        this.logger.warn(
          `policy replay failed (v${configVersion}): ${(err as Error)?.message ?? err}`,
        );
        comparison.replay = null;
      }
    }
    return comparison;
  }

  /** P0-2：查询方案仍生效的持久化人工约束。 */
  async listPlanConstraintsV2(planId: string, actor?: OrgContext) {
    return this.planService.listPlanConstraints(planId, actor);
  }

  async getRoutes(actor?: OrgContext): Promise<RouteGraph> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp。
    this.assertActorForHttp(actor);
    return this.routingService.loadGraph(actor);
  }

  /**
   * 路由计算（V2）：单 person×task（旧契约）或批量候选（P0 扩展）。
   *
   * 批量模式（body.candidates 存在）：Task × Candidate 路由成本 SSOT——
   * 复用 TravelCostService/routeCostProvider 的 estimate（与求解矩阵同一语义），
   * 返回 { data: { candidates } }；blocked/forbiddenZone/坐标缺失 → feasible=false
   * （硬约束），不伪造 0,0 坐标，不返回未经 SSOT 的距离。
   */
  async calculateRouteV2(
    body: CalculateRouteRequest,
    actor?: OrgContext,
  ): Promise<Route | RouteCandidatesResponse> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp。
    this.assertActorForHttp(actor);
    if (body.candidates && body.candidates.length > 0) {
      // NEST-101/111：世界状态（含路由/禁区事实）透传 ctx（org 过滤）。
      const state = await this.worldStateSnapshotService.getCurrentWorldState(actor);
      const stationById = new Map(state.stations.map((s) => [s.id, s]));
      const taskStation = state.tasks.find((t) => t.id === body.taskId)?.stationId;
      const taskPoint = taskStation ? stationById.get(taskStation) : undefined;
      const taskPointCoords = taskPoint
        ? { x: taskPoint.x, y: taskPoint.y }
        : undefined;

      // blocked/forbiddenZone 事实：route graph 状态（与 buildEligibilityMatrix 同源）。
      const blockedEdges = new Set(
        (state.routeStatus ?? [])
          .filter((r) => r.status === 'blocked')
          .map((r) => r.edgeId),
      );
      const forbiddenZoneIds = new Set(
        (state.forbiddenZones ?? []).map((f) => f.zoneId),
      );

      const candidates: RouteCandidateCost[] = [];
      for (const cand of body.candidates) {
        const person = cand.personId
          ? state.persons.find((p) => p.id === cand.personId)
          : undefined;
        const personPoint = person
          ? person.stationId
            ? (() => {
                const st = stationById.get(person.stationId);
                return st ? { x: st.x, y: st.y } : undefined;
              })()
            : person.x != null && person.y != null
              ? { x: person.x, y: person.y }
              : undefined
          : undefined;
        const cost = await this.routeCostProvider.estimate(
          cand.personId ?? 'unknown',
          body.taskId,
          personPoint,
          taskPointCoords,
          // R-6（2026-09-13）：批量路由成本同样透传 actor 租户——同一请求内
          // N 个候选的 loadGraph 由图缓存复用，不再逐候选全图 SELECT。
          { orgId: actor?.primaryOrgId ?? null },
        );
        const routeBlocked =
          cost.source === 'euclidean_fallback' &&
          cost.fallbackReason === 'no_route_edge' &&
          blockedEdges.size > 0;
        const inForbiddenZone =
          (person?.zoneId != null && forbiddenZoneIds.has(person.zoneId)) ||
          (taskStation != null && forbiddenZoneIds.has(taskStation));
        candidates.push({
          personId: cand.personId ?? null,
          deviceId: cand.deviceId ?? null,
          stationId: cand.stationId ?? null,
          feasible: cost.feasible && !routeBlocked && !inForbiddenZone,
          distanceMeters: cost.distanceMeters,
          etaSeconds: cost.etaSeconds,
          routeCostMode: cost.source,
          fallbackReason: inForbiddenZone
            ? 'forbidden_zone'
            : routeBlocked
              ? 'blocked'
              : cost.fallbackReason,
          dataQuality: cost.dataQuality,
          blocked: routeBlocked,
          forbiddenZone: inForbiddenZone,
          // P0：路径几何透传（route_graph 真实 A* / euclidean 两点），与 Solver 同源。
          geometry: cost.geometry ?? [],
        });
      }
      return { data: { taskId: body.taskId, candidates } };
    }
    // NEST-118（2026-08-17）：单对路由计算透传 actor（loadGraph org 过滤拓扑）。
    return this.routingService.calculateRoute(body.personId, body.taskId, actor);
  }

  /**
   * 任务候选资源：为指定任务返回可派人员×设备×工位的资格/路径评估列表。
   * T03 / P1-2（G7）：注入 CandidateEngineService 时委托其富化响应（rejectReasons /
   * scoreBreakdown / stationOptions / timeWindows）；未注入回退旧逻辑（兼容旧单测）。
   */
  async getTaskCandidates(taskId: string, actor?: OrgContext): Promise<TaskCandidatesResponse> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp。
    this.assertActorForHttp(actor);
    if (this.candidateEngineService) {
      // NEST-101/111：候选引擎透传 ctx（资源/预占 org 过滤）。
      return this.candidateEngineService.evaluateTaskCandidates(taskId, actor);
    }
    const state = await this.worldStateSnapshotService.getCurrentWorldState(actor);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const policy = await this.policyService.getActivePolicy(actor?.primaryOrgId || null);
    const config = await this.policyService.getConfig(actor?.primaryOrgId || null);
    const now = Date.now();

    const stationById = new Map(state.stations.map((s) => [s.id, s]));
    const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
    const taskPoint = taskStation
      ? { x: taskStation.x, y: taskStation.y }
      : undefined;

    const doneTaskIds = new Set<string>(
      state.tasks
        .filter((t) => TaskLifecycle.isTerminal(t.status))
        .map((t) => t.id),
    );

    const bookedTimeSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'person')
      .map((r) => ({ personId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedDeviceSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'device')
      .map((r) => ({ deviceId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedStationSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'station')
      .map((r) => ({ stationId: r.resourceId, start: r.startMs, end: r.endMs }));

    const forbiddenZones = (state.forbiddenZones ?? []).map((f) => f.zoneId);
    const safetyBlockedPersonIds = state.safetyBlockedPersonIds ?? [];

    const candidateStartMs = task.planStart ? Date.parse(task.planStart) : now;
    const candidateEndMs = task.planEnd
      ? Date.parse(task.planEnd)
      : now + (config.defaultTaskDurationMs ?? 1_800_000);

    const lockedByTask = (state.lockedAssignments ?? []).find(
      (la) => la.taskId === taskId,
    );
    const assigned = Boolean(task.assigneeId || lockedByTask?.personId);
    const lockedAssigneeId = task.assigneeId ?? lockedByTask?.personId ?? null;
    const lockedDeviceId = task.deviceId ?? lockedByTask?.deviceId ?? null;

    const requiredCaps = task.requiredDeviceCapabilities ?? [];
    // 设备候选：全部设备（资格判定负责 battery/offline/capability 排除）+ 无能力要求时的纯手工(null)。
    const deviceCandidates: Array<(typeof state.devices)[number] | null> = [
      ...state.devices,
    ];
    if (requiredCaps.length === 0) deviceCandidates.push(null);

    const lockedPersonIds = Array.from(
      new Set(
        (state.lockedAssignments ?? [])
          .filter((la) => la.taskId !== taskId)
          .map((la) => la.personId ?? '')
          .filter(Boolean),
      ),
    );

    const candidates: TaskCandidateResource[] = [];

    for (const person of state.persons) {
      const personStation = person.stationId
        ? stationById.get(person.stationId)
        : undefined;
      // 人员无工位且坐标缺失（UNKNOWN）时传 undefined 点，交由 routeCostProvider
      // 走空间实体解析/不可行判定；绝不把 null 当作 0,0 伪坐标（见 02 §13）。
      const personPoint = personStation
        ? { x: personStation.x, y: personStation.y }
        : person.x != null && person.y != null
          ? { x: person.x, y: person.y }
          : undefined;

      const routeCost = await this.routeCostProvider.estimate(
        person.id,
        task.id,
        personPoint,
        taskPoint,
        // R-6（2026-09-13）：回退路径同样透传 actor 租户（路由图按租户分桶缓存）。
        { orgId: actor?.primaryOrgId ?? null },
      );
      const routeInfeasible = routeCost.feasible === false;

      for (const device of deviceCandidates) {
        const eligibility = this.eligibilityService.check(
          {
            id: person.id,
            status: person.status,
            skills: person.skills,
            certifications: person.certifications,
            stationId: person.stationId,
            loadLevel: person.loadLevel,
            fatigueLevel: person.fatigueLevel,
            healthStatus: person.healthStatus,
          },
          {
            id: task.id,
            taskType: task.taskType,
            requiredSkills: task.requiredSkills,
            skillMatchMode: task.skillMatchMode,
            requiredCertifications: task.requiredCertifications,
            stationId: task.stationId,
            zoneId: task.zoneId,
            predIds: task.predecessorIds,
            requiredDeviceCapabilities: requiredCaps,
          },
          device
            ? {
                id: device.id,
                batteryPct: normalizeBatteryPct(device.batteryPct),
                online: device.online,
                status: device.status,
                capabilities: device.capabilities ?? [],
              }
            : null,
          {
            now,
            bookedTimeSlots,
            bookedDeviceSlots,
            bookedStationSlots,
            lockedPersonIds,
            forbiddenZones,
            minBatteryPct: config.minBatteryPct,
            maxContinuousLoad: config.maxContinuousLoad,
            safetyBlockedPersonIds,
            predecessorDone: (id) => doneTaskIds.has(id),
            candidateStartMs,
            candidateEndMs,
          },
        );

        const reasons = [...eligibility.reasons];
        if (routeInfeasible) reasons.push('route_infeasible');

        const eligible = eligibility.eligible && !routeInfeasible;
        const reservationConflict = eligibility.reasons.some((r) =>
          ['time_conflict', 'device_reserved', 'station_reserved'].includes(r),
        );
        const skillMatch = !eligibility.reasons.includes('missing_skill');
        const score = eligible
          ? routeCost.etaSeconds + person.loadLevel * 60
          : Number.POSITIVE_INFINITY;

        candidates.push({
          personId: person.id,
          personName: person.name,
          deviceId: device ? device.id : null,
          stationId: task.stationId,
          eligible,
          etaSeconds: routeCost.etaSeconds,
          distanceMeters: routeCost.distanceMeters,
          skillMatch,
          workload: person.loadLevel,
          batteryPct: device ? normalizeBatteryPct(device.batteryPct) : null,
          reservationConflict,
          score,
          reasons,
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      if (a.personId !== b.personId) return a.personId < b.personId ? -1 : 1;
      const da = a.deviceId ?? '';
      const db = b.deviceId ?? '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return {
      taskId: task.id,
      taskTitle: task.title ?? null,
      taskStatus: task.status ?? null,
      assigned,
      lockedAssigneeId,
      lockedDeviceId,
      solverVersion: policy.solverVersion,
      candidates,
      generatedAt: new Date().toISOString(),
    };
  }

  // ===== Conflict aggregation (V2) =====

  /**
   * 统一调度冲突列表（**单一实现**：`ConflictService`）。
   *
   * 2026-09-12（第 59 轮）：本服务曾内置一份"世界状态 → 冲突"的内存推导作为
   * `ConflictService` 未注入时的回退（约 470 行孪生实现）。它已经漂移：缺
   * 预占过期/感知门控（`perception_inconsistent`）等类型、SSE 推送与生命周期
   * （ACK/RESOLVE/SUPPRESS）也各写一套。保留"两个冲突真相"违反原则 9，
   * 因此删除孪生实现，改为**未装配即显式失败**（不静默返回一份不同的冲突列表——
   * 那正是原则 7 禁止的"看起来有数据、其实不是同一份事实"）。
   */
  async listConflicts(
    params: ConflictsListRequest = {},
    actor?: OrgContext,
  ): Promise<ConflictsListResponse> {
    // R2-SSV-07：HTTP 读面统一 assertActorForHttp。
    this.assertActorForHttp(actor);
    return this.requireConflictService('listConflicts').listConflicts(params, actor);
  }

  /** 返回单个冲突详情；冲突在当前真实数据中不再存在时抛 NotFoundException。R2-SSV-07：HTTP 守卫。 */
  async getConflictDetail(conflictId: string, actor?: OrgContext): Promise<SchedulingConflict> {
    this.assertActorForHttp(actor);
    const service = this.requireConflictService('getConflictDetail');
    const found = await service.getConflictDetail(conflictId, actor);
    return found;
  }

  /**
   * 冲突读面必须装配 `ConflictService`（单一实现）。缺失 = 装配错误，
   * **显式抛错而不是回退另一份推导**（否则同一次查询在不同部署下给出不同冲突集）。
   */
  private requireConflictService(caller: string): ConflictService {
    if (!this.conflictService) {
      throw new Error(
        `${caller} 需要 ConflictService（冲突的唯一实现）：未装配时不提供内存回退——`
        + '两个"冲突真相"会让生命周期/SSE/门控类型漂移（2026-09-12 第 59 轮删除孪生实现）',
      );
    }
    return this.conflictService;
  }

  /**
   * 执行领域：查询。R2-SSV-07：HTTP 守卫。
   *
   * Person scope is enforced here, not only at the controller, so a future
   * route cannot accidentally expose the execution ledger to worker/device_ops.
   */
  async executionList(
    input: {
      planId?: string; taskId?: string; status?: string; personId?: string;
      limit?: number; offset?: number;
    },
    actor?: OrgContext,
  ): Promise<ExecutionListResponse> {
    this.assertActorForHttp(actor);
    if (!this.executionService) throw new Error('executionService not injected');
    const query = { ...input };

    // Non-privileged HTTP callers are constrained to the person bound in the
    // signed token. Internal/background calls (no ALS request context) keep
    // explicit system semantics.
    if (actor && currentRequestContext()) {
      const privileged = actor.isGlobalAdmin || (actor.roles ?? []).some((role) =>
        ['global_admin', 'dispatcher', 'workshop_lead'].includes(role),
      );
      if (!privileged) {
        const boundPersonId = actor.personId?.trim();
        if (!boundPersonId) {
          throw new ForbiddenException('EXECUTION_PERSON_UNBOUND');
        }
        if (query.personId && query.personId !== boundPersonId) {
          throw new ForbiddenException('EXECUTION_PERSON_FORBIDDEN');
        }
        query.personId = boundPersonId;
      }
    }

    // ADR-073：execution 读面 org 接线（org 匹配或 NULL 存量）。
    return this.executionService.list({ ...query, orgId: actor?.primaryOrgId ?? null });
  }

  private mapRun(
    r: typeof ewohSchedulingRun.$inferSelect,
  ): SchedulingRun {
    return {
      runId: r.runId,
      triggerType: r.triggerType ?? 'MANUAL',
      triggerEntityId: r.triggerEntityId ?? null,
      status: (r.status ?? 'queued') as SchedulingRun['status'],
      snapshotVersion: r.snapshotVersion ?? null,
      planIds: (r.planIds as string[] | null) ?? [],
      orgId: r.orgId ?? null,
      error: r.error ?? null,
      failureReason: r.failureReason ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
    };
  }

  /** 计算候选 vs 生效配置的标量与 priority 子字段差异。 */
  private buildConfigParamDeltas(
    active: SchedulingPolicyConfig,
    candidate: SchedulingPolicyConfig,
  ): Record<string, { active: unknown; candidate: unknown }> {
    const deltas: Record<string, { active: unknown; candidate: unknown }> = {};
    const scalarKeys: (keyof SchedulingPolicyConfig)[] = [
      'minBatteryPct',
      'maxContinuousLoad',
      'defaultTaskDurationMs',
      'horizonMinutes',
      'walkingSpeedMps',
      'euclideanDistanceWeight',
      'congestedFactor',
      'blockedFactor',
      'highRiskFactor',
      'mediumRiskFactor',
      'triggerCooldownMs',
    ];
    for (const k of scalarKeys) {
      if (active[k] !== candidate[k]) {
        deltas[k] = { active: active[k], candidate: candidate[k] };
      }
    }
    const priorityKeys: (keyof SchedulingPolicyConfig['priority'])[] = [
      'deadlineRiskWeight',
      'waitingAgeWeight',
      'eventSeverityWeight',
      'productionImpactWeight',
      'downstreamBlockingWeight',
      'manualBoostWeight',
      'agingBaseMs',
    ];
    for (const k of priorityKeys) {
      if (active.priority[k] !== candidate.priority[k]) {
        deltas[`priority.${k}`] = {
          active: active.priority[k],
          candidate: candidate.priority[k],
        };
      }
    }
    return deltas;
  }

  /** 基于求解目标权重（与 buildPolicy 一致）的归一化 composite objective 估计。 */
  private estimateObjective(
    active: SchedulingPolicyConfig,
    candidate: SchedulingPolicyConfig,
  ): { active: number; candidate: number } {
    const score = (c: SchedulingPolicyConfig): number =>
      c.priority.deadlineRiskWeight * 3 +
      c.euclideanDistanceWeight +
      c.highRiskFactor / 2 +
      c.minBatteryPct / 30;
    return { active: score(active), candidate: score(candidate) };
  }

  private buildVerdict(
    deltas: Record<string, { active: unknown; candidate: unknown }>,
  ): string {
    const changed = Object.keys(deltas);
    if (changed.length === 0) {
      return '候选版本与生效版本参数完全一致，无实际变更。';
    }
    return `候选版本相对生效版本存在 ${changed.length} 项参数差异（${changed.join(
      ', ',
    )}）；请结合反馈 KPI 决策，本结果仅为只读 shadow 对比。`;
  }
}
