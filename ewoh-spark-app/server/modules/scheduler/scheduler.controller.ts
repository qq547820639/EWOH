import {
  HttpCode,
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  BadRequestException,
  Req,
  Headers,
  Sse,
  MessageEvent,
  Logger,
} from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { Optional } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { Roles } from '../shared/roles.decorator';
import { SchedulerStreamService } from './scheduler-stream.service';
import { DurationModelTrainingService } from './prediction/duration-model-training.service';
import { DecisionHistoryService } from './decision-history.service';
import { SchedulingContextService } from './scheduling-context.service';
import { ResourceProjectionService } from './resource-projection.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { ConflictService } from './conflict.service';
import { KpiService } from './kpi.service';
import { PlanCompareService } from './plan-compare.service';
import { ConflictPreviewService } from './conflict-preview.service';
import { OverridePreviewService } from './override-preview.service';
import { ShadowPolicyService } from './shadow-policy.service';
import { PolicyActivationService } from './policy-activation.service';
import { PolicyReplayService } from './policy-replay.service';
import { ReplanPreviewService } from './replan-preview.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import type {
  GeneratePlansRequest,
  ConfirmPlanRequest,
  ScheduleWeights,
  CreateRunRequest,
  ApprovePlanRequest,
  RejectPlanRequest,
  ReplanRequest,
  CalculateRouteRequest,
  PlanOverrideRequest,
  SchedulingEventRequest,
  RecordActualsRequest,
  SchedulingPolicyConfig,
  ConflictsListRequest,
  SchedulingConflictType,
  ConflictSeverity,
  SchedulingConflictScope,
  ReplanPreviewRequest,
} from '@shared/api.interface';

@Controller('api/scheduler')
export class SchedulerController {
  private readonly logger = new Logger(SchedulerController.name);

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly schedulerStreamService: SchedulerStreamService,
    private readonly resourceProjectionService: ResourceProjectionService,
    private readonly replanCoordinatorService: ReplanCoordinatorService,
    private readonly conflictService: ConflictService,
    // Phase 4：执行 / KPI / Compare / Preview / Shadow / Activation（薄门面）
    private readonly kpiService: KpiService,
    private readonly planCompareService: PlanCompareService,
    private readonly conflictPreviewService: ConflictPreviewService,
    private readonly overridePreviewService: OverridePreviewService,
    private readonly shadowPolicyService: ShadowPolicyService,
    private readonly policyActivationService: PolicyActivationService,
    private readonly policyReplayService: PolicyReplayService,
    private readonly replanPreviewService: ReplanPreviewService,
    // P0-2：统一调度上下文（GET /api/scheduler/context，org 隔离单一时间切片）。
    // 追加在末尾：保持既有测试 positional 注入不破坏（DI 按类型解析，顺序无关）。
    private readonly schedulingContextService: SchedulingContextService,
    // NO-13g / ADR-056：经验时长模型重训（@Optional——既有直构测试不破坏；
    // 生产模块必装配；缺失时端点显式报错不静默）。
    @Optional() private readonly durationModelTrainingService?: DurationModelTrainingService,
    // NO-13p / ADR-065：Decision History 跨 kind 检索（@Optional——既有直构
    // 测试不破坏；生产模块必装配；缺失时端点显式报错不静默）。
    @Optional() private readonly decisionHistoryService?: DecisionHistoryService,
  ) {}

  /**
   * NO-13g / ADR-056：经验时长模型重训/激活（真实执行反馈 → 统计模型 →
   * ewoh_model_registry 落版 + 内存刷新）。样本不足 → 显式 not_enough_data
   * （不落版不伪造，§33）。预测面 shadow-only（预测只是优化器输入）。
   */
  /**
   * 训练样本资格摘要（学习控制台只读）。
   *
   * 让用户能回答"为什么不能重训"：区分没有真实回执、有真实回执但缺独立
   * 设备证据、以及设备证据与执行事实不一致。模拟/人工回执不计入可训练样本。
   */
  @Get('predictions/task-duration/samples')
  async taskDurationSamples(@Req() request: { userContext?: OrgContext }) {
    if (!this.durationModelTrainingService) {
      throw new BadRequestException('duration model training not available（模块未装配）');
    }
    const orgId = request.userContext?.primaryOrgId;
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：训练样本统计必须租户作用域（§15/§16）');
    }
    return this.durationModelTrainingService.summarizeTrainingSamples(orgId.trim());
  }

  @Post('predictions/task-duration/retrain')
  async retrainTaskDurationModel(@Req() request: { userContext?: OrgContext }) {
    if (!this.durationModelTrainingService) {
      throw new BadRequestException('duration model training not available（模块未装配）');
    }
    const orgId = request.userContext?.primaryOrgId;
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：模型训练必须租户作用域（§15/§16，ADR-070）');
    }
    const summary = await this.durationModelTrainingService.retrain(orgId.trim());
    if (!summary.ok) {
      throw new BadRequestException(`retrain_not_enough_data: ${summary.notEnoughDataReason ?? 'unknown'}`);
    }
    // 谱系（lineage）：新版本由哪些样本、按什么资格策略产生。
    // 只回版本号会让"这个模型是怎么来的"无法追溯，而时长模型会影响排程预测。
    const lineage = await this.durationModelTrainingService
      .summarizeTrainingSamples(orgId.trim())
      .catch(() => null);
    return {
      ok: true,
      modelId: 'task-duration-empirical',
      version: summary.version,
      n: summary.model?.count,
      medianMs: summary.model?.medianMs,
      p90Ms: summary.model?.p90Ms,
      lineage: {
        trainedFrom: 'ewoh_scheduling_feedback',
        eligibilityPolicy: lineage?.eligibilityPolicy ?? 'independent-device-receipt-required',
        trainableSamples: lineage?.trainable ?? null,
        flaggedEligible: lineage?.flaggedEligible ?? null,
        minSamplesRequired: lineage?.minSamplesRequired ?? null,
        perTaskType: summary.perTaskType ?? [],
      },
    };
  }

  /**
   * P1-CMAP-002：统一资源状态权威投影（ResourceProjection SSOT）。
   * map / ResourcePool / Scheduler / Dispatch 应统一从此消费；
   * 前端 ResourcePool 不得自行拼装 SpatialEntity/DeviceInfo 作为正式资源状态。
   */
  @Get('resources/state')
  async getUnifiedResourceState(@Req() request?: { userContext?: OrgContext }) {
    // NEST-102（2026-08-17）：资源投影透传认证上下文（org 过滤）。
    return this.resourceProjectionService.getUnifiedResourceState(request?.userContext);
  }

  /**
   * P0-2：统一调度上下文（单一 org 时间切片，版本字段真实取值）。
   * Command Map 应一次性从此消费 snapshotVersion/resourceVersion/routeGraphVersion/
   * policyVersion/eventSequence/sourceTimestamp/tasks/resources/reservations/constraints/
   * dataQuality，避免跨切片组合成伪"当前状态"。
   */
  @Get('context')
  async getSchedulingContext(@Req() request: { userContext?: OrgContext }) {
    return this.schedulingContextService.getContext(request.userContext);
  }

  /**
   * NO-13p / ADR-065：Decision History 跨 kind 检索（只读聚合读面——
   * Decision Catalog 8 类 kind 跨四表统一检索，§12/§15/§18/§33）。
   * kind/status 过滤器 fail-closed；非法记录显式 skippedInvalid 计数。
   */
  @Get('decision-history')
  async getDecisionHistory(
    @Req() request: { userContext?: OrgContext },
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!this.decisionHistoryService) {
      throw new BadRequestException('decision history service not available（模块未装配）');
    }
    return this.decisionHistoryService.listDecisions(
      request.userContext?.primaryOrgId ?? null,
      {
        kind,
        status,
        limit: limit != null && limit !== '' ? Number(limit) : undefined,
        offset: offset != null && offset !== '' ? Number(offset) : undefined,
      },
    );
  }

  /**
   * @deprecated 请改用 V2 接口 POST /api/scheduler/runs
   */
  @Post('plans')
  async generatePlans(
    @Body() body?: GeneratePlansRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.legacyCompatibility(
      this.schedulerService.generatePlans(body, request?.userContext),
      'POST /plans',
      'POST /api/scheduler/runs',
    );
  }

  /**
   * @deprecated 请改用 V2 接口 GET /api/scheduler/runs/:runId 或 GET /api/scheduler/plans/:planId
   */
  @Get('plans')
  async getPlans(
    @Query('status') status?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.legacyCompatibility(
      this.schedulerService.getPlans(status, request?.userContext),
      'GET /plans',
      'GET /api/scheduler/plans/:planId',
    );
  }

  /**
   * @deprecated 请改用 V2 接口 POST /api/scheduler/plans/:planId/approve 或 /dispatch
   */
  @Post('plans/:planId/confirm')
  async confirmPlan(
    @Param('planId') planId: string,
    @Body() body: ConfirmPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('reason is required');
    }
    return this.legacyCompatibility(
      this.schedulerService.confirmPlan(
        planId,
        body.reason,
        body.operator,
        request.userContext,
      ),
      'POST /plans/:planId/confirm',
      'POST /api/scheduler/plans/:planId/approve',
    );
  }

  /**
   * DR-5 方案取消/回滚（standalone_077）：approved/dispatched/executing 方案的
   * 受控部分回退——未开始 assignment 取消并释放预占、任务退回待派发池、
   * 未开始 Execution 标记 CANCELLED；已开始的不可回退项如实回报。
   */
  @Post('plans/:planId/cancel')
  @HttpCode(200)
  async cancelPlan(
    @Param('planId') planId: string,
    @Body() body: { reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.reason?.trim()) {
      throw new BadRequestException('reason 必填：取消/回滚必须可解释、可审计');
    }
    return this.schedulerService.cancelPlanV2(planId, body, request.userContext);
  }

  @Post('plans/:planId/reject')
  async rejectPlanV2(
    @Param('planId') planId: string,
    @Body() body: RejectPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.rejectPlanV2(planId, body, request.userContext);
  }

  @Get('audit')
  async getAudit(
    @Query('planId') planId?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.schedulerService.getAudit(planId, request?.userContext);
  }

  // ===== Scheduling V2 endpoints =====

  @Post('runs')
  async createRun(
    @Body() body: CreateRunRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.createRun(body, request.userContext);
  }

  /**
   * v0.7 B2/Batch6.1 事件驱动智能重排：注入真实业务事件（设备离线 / 路线阻断 / 安全事件等）。
   * - 事件 → 局部重排（影响分析 → 冻结无关任务 → 求解 → 持久化 → 熔断）；
   * - 级联 → 基于最新世界状态检查路由/预占冲突并 scoped 重排（冷却去抖防风暴）。
   *
   * 与 POST /runs 的区别：
   * - /runs 是"手动/全量"调度（MANUAL 或任意 trigger 走全量求解）；
   * - /events 是"事件驱动/局部"调度：仅重排受影响任务，无关任务不 churn。
   *
   * 幂等与冷却由 TriggerService 保证（同 triggerKey 去重 + 冷却窗口去抖，跨进程可靠）；
   * 失败时 ReplanCoordinator 将 run 置为 failed 并记录日志，不抛错阻断事件源。
   */
  @Post('events')
  async injectSchedulingEvent(
    @Body() body: SchedulingEventRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.trigger) {
      throw new BadRequestException('trigger is required');
    }
    return this.schedulerService.injectSchedulingEvent(body, request.userContext);
  }

  /** M03：Replan Preview（dry-run readonly，不落库不派工；08 §5）。 */
  @Post('replan/preview')
  @HttpCode(200)
  async previewReplan(
    @Body() body: ReplanPreviewRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.triggerType) {
      throw new BadRequestException('triggerType is required');
    }
    return this.replanPreviewService.previewReplan(
      body.triggerType,
      body.triggerIds ?? [],
      request.userContext,
    );
  }

  /**
   * v0.7 D1 反馈闭环：回填任务执行实际值（actualStart/actualEnd/实际资源等）。
   * 由任务执行方（移动端/边缘/外部系统）在任务 start / complete 时调用，
   * 按 assignmentId/planId/taskId 匹配 feedback 行回填，重复提交为覆盖式更新（幂等）。
   * 观测型回填：不改变任何调度行为，仅驱动 planned-vs-actual KPI 与策略影子评估。
   */
  @Post('feedback/actuals')
  async recordTaskActuals(
    @Body() body: RecordActualsRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.recordTaskActuals(body, request.userContext);
  }

  /**
   * P0-1 Active Plan 权威查询：非终态方案（shadow/approved/dispatched/executing）。
   * 前端刷新 / SSE resync 必须调用此端点恢复权威方案列表。
   */
  @Get('active-plans')
  async getActivePlans(@Req() request?: { userContext?: OrgContext }) {
    return this.schedulerService.getActivePlans(request?.userContext);
  }

  @Get('runs')
  async listRuns(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() request: { userContext?: OrgContext } = { userContext: undefined },
  ) {
    return this.schedulerService.listRuns(
      {
        status,
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        from,
        to,
      },
      // Batch 8 RLS 缓解：传入租户上下文，listRuns 按 org 过滤运行历史。
      request.userContext,
    );
  }

  @Get('runs/:runId')
  async getRun(
    @Param('runId') runId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.schedulerService.getRun(runId, request?.userContext);
  }

  @Get('snapshot')
  async getSnapshot(@Req() request?: { userContext?: OrgContext }) {
    // NEST-111（2026-08-17）：透传认证上下文，snapshot 读取按 org 过滤。
    return this.schedulerService.getSnapshot(request?.userContext);
  }

  @Get('plans/:planId')
  async getPlan(
    @Param('planId') planId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.schedulerService.getPlanDetail(planId, request?.userContext);
  }

  /**
   * NO-62c：方案过期诊断（只读）——"这个方案还能批吗？如果不能，变了什么？"
   *
   * 与审批 409 使用同一诊断实现，页面不再需要靠"点一下审批看会不会报错"来探测新鲜度。
   */
  @Get('plans/:planId/staleness')
  async getPlanStaleness(
    @Param('planId') planId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.explainPlanStaleness(planId, request?.userContext);
  }

  /** P0-2：查询方案仍生效的持久化人工约束。 */
  @Get('plans/:planId/constraints')
  async getPlanConstraints(
    @Param('planId') planId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.schedulerService.listPlanConstraintsV2(planId, request?.userContext);
  }

  /** P0-2：解除一条人工约束（软删除 + 审计；解除后下次 replan 不再继承）。 */
  @Post('constraints/:constraintId/deactivate')
  async deactivateConstraint(
    @Param('constraintId') constraintId: string,
    @Body() body: { operator?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.deactivateConstraintV2(
      constraintId,
      request.userContext,
      body?.reason,
    );
  }

  @Post('plans/:planId/approve')
  @HttpCode(200)
  async approvePlan(
    @Param('planId') planId: string,
    @Body() body: ApprovePlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.approvePlanV2(planId, body, request.userContext);
  }

  /**
   * 派工（支持分波次 / 部分执行）。
   *
   * body 省略或 `assignmentIds` 为空 → 派发全部待派工 assignment（原有行为）。
   * 提供 `assignmentIds` → 只派发这一波；波内全有或全无。
   * 响应携带 `dispatch.remainingAssignmentIds`：非空即"部分执行"，
   * 此时计划刻意保持 `approved`（`dispatched` 在契约中是终态，语义为"全部转任务"）。
   */
  @Post('plans/:planId/dispatch')
  @HttpCode(200)
  async dispatchPlan(
    @Param('planId') planId: string,
    @Body() body: { assignmentIds?: string[] } | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    const assignmentIds = Array.isArray(body?.assignmentIds) ? body.assignmentIds : undefined;
    if (assignmentIds && assignmentIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new BadRequestException('assignmentIds 必须是非空字符串数组');
    }
    return this.schedulerService.dispatchPlanV2(
      planId,
      request.userContext,
      assignmentIds?.length ? { assignmentIds } : undefined,
    );
  }

  @Post('plans/:planId/replan')
  async replan(
    @Param('planId') planId: string,
    @Body() body: ReplanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.replanV2(planId, body, request.userContext);
  }

  /** 应用人工覆盖（锁定/排除/偏好/加急/调时）并触发 V2 重排，返回 before/after 差异。 */
  @Post('plans/:planId/overrides')
  async applyOverrides(
    @Param('planId') planId: string,
    @Body() body: PlanOverrideRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.applyOverrides(planId, body, request.userContext);
  }

  /** T04 / P1-8：覆盖影响预览（纯计算，不落库不重排；7 项 delta）。 */
  @Post('plans/:planId/overrides/preview')
  @HttpCode(200)
  async previewOverrides(
    @Param('planId') planId: string,
    @Body() body: PlanOverrideRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.overridePreviewService.preview(planId, body, request.userContext);
  }

  @Get('tasks/:id/candidates')
  async getTaskCandidates(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-111（2026-08-17）：透传认证上下文，候选资源按 org 过滤。
    return this.schedulerService.getTaskCandidates(id, request?.userContext);
  }

  @Get('routes')
  async getRoutes(@Req() request?: { userContext?: OrgContext }) {
    // ADR-074：路由拓扑读面 org 条件（org 匹配或 NULL 存量）。
    return this.schedulerService.getRoutes(request?.userContext);
  }

  @Post('routes/calculate')
  @HttpCode(200)
  async calculateRoute(
    @Body() body: CalculateRouteRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-111（2026-08-17）：路由计算走 loadGraph（org 过滤拓扑）。
    return this.schedulerService.calculateRouteV2(body, request?.userContext);
  }

  @Get('conflicts')
  async listConflicts(
    @Query('type') type?: SchedulingConflictType,
    @Query('severity') severity?: ConflictSeverity,
    @Query('scope') scope?: SchedulingConflictScope,
    @Query('resourceId') resourceId?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.conflictService.listConflicts(
      {
        type,
        severity,
        scope,
        resourceId,
      } satisfies ConflictsListRequest,
      request?.userContext,
    );
  }

  @Get('conflicts/:id')
  async getConflict(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.conflictService.getConflictDetail(id, request?.userContext);
  }

  /** T04 / P1-5（G5）：显式冲突归并触发（写路径；GET /conflicts 为纯读）。 */
  @Post('conflicts/reconcile')
  @HttpCode(200)
  async reconcileConflicts(@Req() request: { userContext?: OrgContext }) {
    return this.conflictService.reconcileNow(request.userContext);
  }

  /** OPEN → ACKNOWLEDGED（人工确认，记录 acknowledgedBy/At + 审计 + SSE）。 */
  @Post('conflicts/:id/acknowledge')
  async acknowledgeConflict(
    @Param('id') id: string,
    @Body() body: { operator?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.conflictService.acknowledge(
      id,
      body?.operator ?? '',
      body?.reason ?? '',
      request.userContext,
    );
  }

  /** OPEN/ACKNOWLEDGED/SUPPRESSED → RESOLVED（人工 resolve；自动消除走 reconcile）。 */
  @Post('conflicts/:id/resolve')
  async resolveConflict(
    @Param('id') id: string,
    @Body() body: { operator?: string; reason?: string; resolution?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.conflictService.resolve(
      id,
      body?.operator ?? '',
      body?.reason ?? '',
      body?.resolution ?? '',
      request.userContext,
    );
  }

  /** OPEN/ACKNOWLEDGED → SUPPRESSED（suppressUntilMs 内不再告警/推 SSE，到期自动回 OPEN）。 */
  @Post('conflicts/:id/suppress')
  async suppressConflict(
    @Param('id') id: string,
    @Body() body: { operator?: string; reason?: string; suppressUntilMs?: number },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.conflictService.suppress(
      id,
      body?.operator ?? '',
      body?.reason ?? '',
      body?.suppressUntilMs,
      request.userContext,
    );
  }

  // ===== SchedulingPolicy versioning (Task 6: 命令图调度闭环) =====

  /** 返回当前生效策略 + 配置（只读）。NEST-105：透传认证上下文 org 过滤。 */
  @Get('policy')
  async getPolicy(@Req() request?: { userContext?: OrgContext }) {
    return this.schedulerService.getPolicy(request?.userContext);
  }

  /** 列出全部策略版本（含 active 标志、操作人、创建时间）。 */
  @Get('policy/versions')
  async listPolicyVersions(@Req() request?: { userContext?: OrgContext }) {
    return this.schedulerService.listPolicyVersions(request?.userContext);
  }

  /** 注册候选策略版本（inactive，绝不自动激活）。 */
  @Post('policy/versions')
  async registerPolicyVersion(
    @Body() body: { config: SchedulingPolicyConfig; operator?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.config) {
      throw new BadRequestException('config is required');
    }
    return this.schedulerService.registerPolicyVersion(
      body.config,
      request.userContext,
    );
  }

  /** shadow/只读对比：候选版本 vs 当前生效版本（反馈 KPI + 目标权重）。 */
  @Get('policy/versions/:version/compare')
  async comparePolicyVersion(
    @Param('version') version: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.comparePolicyVersion(
      this.parsePolicyVersion(version),
      request.userContext,
    );
  }

  /** 显式激活指定版本（唯一生产策略翻转路径，需人工审批 approver+reason + 审计；P4-T2 guarded）。 */
  @Post('policy/versions/:version/activate')
  async activatePolicyVersion(
    @Param('version') version: string,
    @Body() body: { approver?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.activatePolicyVersion(
      this.parsePolicyVersion(version),
      body ?? {},
      request.userContext,
    );
  }

  // ===== Scheduling 实时事件流（SSE）=====

  /**
   * SSE：订阅调度事件流，附带 15s 心跳防止连接超时。
   *
   * Last-Event-ID 增量续传（P2 收尾）：
   * - 首次连接（无 Last-Event-ID 头）→ 纯实时订阅（与历史行为完全一致，无重放）。
   * - 带 Last-Event-ID（outbox sequence）→ 先经 replaySince 重放缺失事件再接入实时流：
   *   - 无缺口 → 按 sequence 升序先发重放增量事件（scheduling.event），再接实时事件，避免乱序；
   *   - 有缺口/客户端超前 → 先发一个 resync 事件（data 含 currentSequence/reason），
   *     客户端据此走全量重同步，再接入实时流。
   * - 重放查询失败 → 降级为纯实时订阅，不阻断 SSE 连接。
   */
  @Sse('v2/stream')
  stream(
    @Headers('last-event-id') lastEventIdHeader?: string,
    @Req() request?: { userContext?: OrgContext },
  ): Observable<MessageEvent> {
    this.schedulerStreamService.start().catch(() => undefined);
    // P4-SSE：组织隔离——订阅者仅收到本 org 事件 + 全局事件（orgId null）。
    const viewerOrgId = request?.userContext?.primaryOrgId ?? null;
    // NEST-113 修复（2026-08-17）：viewerOrgId 缺失（无认证上下文）时不再
    // 放行全部事件——业务事件一律过滤（仅保留心跳），fail-closed。全局 guard
    // 正常生效时本分支不可达，此为纵深防御。
    if (!viewerOrgId) {
      this.logger.warn('SSE stream requested without org context; business events suppressed');
    }

    // 实时事件 + 心跳。
    const live$ = merge(
      this.schedulerStreamService.events().pipe(
        // P4-SSE：org 隔离（全局事件放行）；NEST-113：无 viewerOrg 一律不放行业务事件。
        filter((event) =>
          Boolean(viewerOrgId) && (event.orgId == null || event.orgId === viewerOrgId),
        ),
        map(
          (event): MessageEvent => ({
            type: 'scheduling.event',
            // SSE id 字段承载 outbox sequence：客户端断线重连时原样回传
            // Last-Event-ID，服务端据此增量续传。
            id: String(event.sequence),
            data: JSON.stringify(event),
          }),
        ),
      ),
      interval(15_000).pipe(
        map(
          (): MessageEvent => ({
            type: 'heartbeat',
            data: JSON.stringify({ ts: new Date().toISOString() }),
          }),
        ),
      ),
    );

    const lastEventId = this.parseLastEventId(lastEventIdHeader);
    if (lastEventId == null) {
      // 首次连接（无 Last-Event-ID）：全量订阅，与现状完全一致。
      return live$;
    }

    // Last-Event-ID 增量续传：重放事件必须先于实时事件（避免乱序）。
    // 缓冲方案：重放查询期间实时事件先入 pending，重放完成后按序补发，
    // 避免 concat 订阅时序造成的重放窗口丢事件。
    return new Observable<MessageEvent>((subscriber) => {
      const pending: MessageEvent[] = [];
      let preludeDone = false;
      const liveSub = live$.subscribe({
        next: (message) => {
          if (preludeDone) subscriber.next(message);
          else pending.push(message);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      // NEST-113：无 viewerOrg 时不做增量重放（replaySince 无 org 过滤会返回
      // 全部租户事件），直接发 resync 让客户端走认证路径全量同步。
      const replayPromise = viewerOrgId
        ? this.schedulerStreamService.replaySince(lastEventId, lastEventId, viewerOrgId)
        : this.schedulerStreamService.currentSequence().then((currentSequence) => ({
            events: [] as never[],
            resyncNeeded: true as const,
            gap: false as const,
            currentSequence,
          }));

      replayPromise
        .then((result) => {
          if (result.resyncNeeded) {
            // 缺口/客户端超前 → 通知客户端放弃增量、全量重同步。
            subscriber.next({
              type: 'resync',
              id: String(result.currentSequence),
              data: JSON.stringify({
                currentSequence: result.currentSequence,
                reason: result.gap ? 'gap detected' : 'client ahead of server',
              }),
            });
          } else {
            // 正常 → 先发重放增量事件（sequence 升序），再接实时流。
            for (const event of result.events) {
              subscriber.next({
                type: 'scheduling.event',
                id: String(event.sequence),
                data: JSON.stringify(event),
              });
            }
          }
          preludeDone = true;
          for (const message of pending) subscriber.next(message);
          pending.length = 0;
        })
        .catch((err: unknown) => {
          // 重放查询失败：降级为纯实时订阅，不阻断 SSE 连接。
          this.logger.error(
            'SSE replaySince failed, fallback to live stream',
            err instanceof Error ? err.stack : String(err),
          );
          preludeDone = true;
          for (const message of pending) subscriber.next(message);
          pending.length = 0;
        });

      return () => liveSub.unsubscribe();
    });
  }

  /** 解析 SSE Last-Event-ID 头为 outbox sequence；缺失/非法返回 null（按首次连接处理）。 */
  private parseLastEventId(value: string | undefined): number | null {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }

  /** 解析并校验策略版本号（正整数）。 */
  private parsePolicyVersion(version: string): number {
    const v = Number(version);
    if (!Number.isInteger(v) || v <= 0) {
      throw new BadRequestException('invalid policy version');
    }
    return v;
  }

  /**
   * 兼容适配器：legacy 模板风格接口仍委托到服务执行（保持向后可用），
   * 但响应携带废弃提示，引导调用方迁移到 V2 规范路径。新功能不得依赖 legacy 路径。
   */
  private async legacyCompatibility<T>(
    delegate: Promise<T>,
    legacyPath: string,
    v2Path: string,
  ): Promise<{ deprecated: true; notice: string; legacyPath: string; suggestedV2: string; data: T }> {
    const data = await delegate;
    return {
      deprecated: true,
      notice: `接口 ${legacyPath} 已废弃，请迁移到 V2 路径 ${v2Path}。`,
      legacyPath,
      suggestedV2: v2Path,
      data,
    };
  }
  // ==========================================================================
  // Phase 4 / P4-EXEC：Execution Feedback
  // ==========================================================================

  /**
   * 执行回执（含现场人员）。
   *
   * 允许 `worker` 调用是**有意**的：没有它，现场人员无法报告自己的开工/完工，
   * "感知—执行—反馈"闭环对真正的执行者就是断的。放宽的只是"能否到达该处理器"，
   * 归属仍由 ExecutionReceiptApplicationService 强制：非特权角色必须满足
   * `assignment.personId === ctx.personId`（账号↔人员绑定），未绑定或他人任务
   * 一律 403。因此这里不构成越权面。
   */
  @Post('executions/:assignmentId/update')
  @Roles('worker', 'dispatcher', 'workshop_lead', 'device_ops', 'global_admin')
  async updateExecution(
    @Param('assignmentId') assignmentId: string,
    @Body() body: import('@shared/api.interface').ExecutionUpdateRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.executionUpdate(assignmentId, body, request.userContext);
  }

  /**
   * 现场作业台只读投影：**只返回调用者本人的工作**。
   *
   * 为什么需要单独端点（2026-09-10 现场闭环审计）：SchedulerController 通过
   * FALLBACK_CONTROLLER_ROLES 整体限定为 global_admin/dispatcher/workshop_lead，
   * 因此 `worker` 访问任何 `/api/scheduler/*` 都是 403——现场作业台对真正的现场
   * 人员不可用。而放开工人读 `GET /executions` 又会暴露全厂执行台账。
   *
   * 本端点把范围**由服务端从 ctx.personId 推导**（不接受客户端传 personId）：
   * 工人只能看到分配给自己的记录；未绑定人员则 fail-closed 403。
   */
  @Get('field/my-work')
  @Roles('worker', 'dispatcher', 'workshop_lead', 'device_ops', 'global_admin')
  async myFieldWork(@Req() request: { userContext?: OrgContext }) {
    return this.schedulerService.myFieldWork(request.userContext);
  }

  @Get('executions')
  async listExecutions(
    @Query('planId') planId?: string,
    @Query('taskId') taskId?: string,
    @Query('status') status?: string,
    // 现场作业台按"分配给我的人"筛选（服务端过滤，保持 org 作用域）。
    @Query('personId') personId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.schedulerService.executionList(
      {
        planId,
        taskId,
        status,
        personId,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
      request?.userContext,
    );
  }

  // ==========================================================================
  // Phase 4 / P4-KPI：生产指标
  // ==========================================================================

  @Get('kpi/history')
  async getKpiHistory(
    @Query('limit') limit?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NO-89a：门禁指标历史序列（趋势可见，漂移早发现）。org 作用域与 GET kpi 一致。
    return this.kpiService.listHistory(
      request?.userContext?.primaryOrgId ?? null,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('kpi')
  async getKpi(
    @Query('persist') persist?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // ADR-073：KPI 聚合 org 作用域（跨租户聚合关闭，§15/§16）。
    return this.kpiService.aggregate({
      persist: persist === '1',
      orgId: request?.userContext?.primaryOrgId ?? null,
    });
  }

  // ==========================================================================
  // Phase 4 / P4-COMPARE：Plan Compare（权威 Diff）
  // ==========================================================================

  @Get('plans/:planId/compare/:otherPlanId')
  async comparePlansV2(
    @Param('planId') planId: string,
    @Param('otherPlanId') otherPlanId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // ADR-073：两个方案读取都经 ADR-071 getPlan 守卫（跨租户 404）。
    const [baseline, candidate] = await Promise.all([
      this.schedulerService.getPlanDetail(planId, request?.userContext),
      this.schedulerService.getPlanDetail(otherPlanId, request?.userContext),
    ]);
    return this.planCompareService.compare(baseline, candidate);
  }

  // ==========================================================================
  // Phase 4 / P4-PREVIEW：Conflict Preview Replan（readonly）
  // ==========================================================================

  @Post('conflicts/:id/actions/preview')
  async previewConflictAction(
    @Param('id') conflictId: string,
    @Body() body: import('@shared/api.interface').ConflictPreviewRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-112（2026-08-17）：冲突读取透传认证上下文（跨租户 404）。
    const conflict = await this.conflictService.getConflictDetail(conflictId, request?.userContext);
    // R2-SSV-08 / NEST-002（2026-08-17）：preview 透传认证上下文——此前第 5 参
    // ctx 缺失，preview 内部回退空 org 系统 ctx，快照/基线/约束加载全部无
    // 租户过滤（NEST-001/002 修复被调用方旁路）。
    return this.conflictPreviewService.preview(
      conflictId,
      {
        type: conflict.type,
        scope: conflict.scope,
        resourceId: conflict.resourceId,
        taskIds: conflict.taskIds,
        message: conflict.message,
      },
      null,
      body.action,
      request?.userContext,
    );
  }

  // ==========================================================================
  // Phase 4 / P4-REPLAY：Policy Replay（持久化 + deterministic）
  // ==========================================================================

  @Post('policy/replay')
  async replayPolicy(
    @Body() body: import('@shared/api.interface').PolicyReplayRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.policyReplayService.replayAndPersist(body.candidatePolicyVersion, {
      snapshotVersion: body.snapshotVersion,
      seed: body.seed,
      orgId: request.userContext?.primaryOrgId ?? null,
      ctx: request.userContext,
    });
  }

  @Get('policy/replay')
  async listReplays(
    @Query('candidatePolicyVersion') candidateVersion?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-112（2026-08-17）：org 只允许来自认证上下文——query 参数 orgId
    // 欺骗路径废弃（与 listActivations 同口径，ADR-073 §3/§15）。
    return this.policyReplayService.listReplayRecords(
      candidateVersion ? Number(candidateVersion) : undefined,
      request?.userContext?.primaryOrgId ?? null,
    );
  }

  // ==========================================================================
  // Phase 4 / P4-SHADOW：Shadow Policy + Shadow Plan
  // ==========================================================================

  @Post('policy/:version/shadow')
  async enableShadow(
    @Param('version') version: string,
    @Body() body: { operator?: string; reason?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-115（2026-08-17）：透传认证上下文（策略状态变更 org 校验）。
    await this.shadowPolicyService.setStatus(
      Number(version),
      'SHADOW',
      body.operator,
      request?.userContext,
    );
    return { ok: true, status: 'SHADOW', policyVersion: Number(version) };
  }

  @Post('policy/:version/shadow/plan')
  async generateShadowPlan(
    @Param('version') version: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.shadowPolicyService.generateShadowPlan(Number(version), request.userContext);
  }

  // ==========================================================================
  // Phase 4 / P4-GATE：Human-gated Activation + Rollback
  // ==========================================================================

  @Post('policy/:version/gate')
  async evaluateGate(
    @Param('version') version: string,
    @Body() body: { replayId?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    // R2-SSV-02（2026-08-17）：gate 评估透传 orgId——此前 controller 不取
    // userContext，aggregateForPolicyEvaluation 无 org 在 HTTP 上下文内必抛
    // 400（gate 端点恒不可用）。
    return this.policyActivationService.evaluateGate(
      Number(version),
      body.replayId ?? null,
      request?.userContext?.primaryOrgId ?? null,
    );
  }

  @Post('policy/:version/activate')
  async activatePolicy(
    @Param('version') version: string,
    @Body() body: {
      operator: string;
      reason?: string;
      replayId?: string;
      /**
       * 证据不足时的显式人工确认（见 PolicyActivationService.activate）。
       * 注意：HTTP 面**不接受**调用方自带的 gateResult——Gate 结论必须由服务端
       * 现场评估产生。此前 controller 直接透传 body.gateResult，任何具备激活
       * 权限的调用方都能伪造 `{passed:true}` 绕过 Gate 与全部安全检查。
       */
      acknowledgeInsufficientEvidence?: boolean;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.policyActivationService.activate(Number(version), {
      operator: body.operator ?? request.userContext?.userId ?? 'system',
      reason: body.reason,
      replayId: body.replayId,
      // 服务端权威评估：不读取任何调用方提供的 Gate 结果。
      gateResult: null,
      acknowledgeInsufficientEvidence: body.acknowledgeInsufficientEvidence === true,
      orgId: request.userContext?.primaryOrgId ?? null,
    }, request.userContext);
  }

  @Post('policy/activations/:activationId/rollback')
  async rollbackPolicy(
    @Param('activationId') activationId: string,
    @Body() body: { operator: string; reason?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-112（2026-08-17）：透传认证上下文（rollback 按 org 校验归属，
    // 跨租户 activationId 404，NEST-032）。
    return this.policyActivationService.rollback(
      activationId,
      body.operator ?? request?.userContext?.userId ?? 'system',
      body.reason,
      request?.userContext,
    );
  }

  @Get('policy/activations')
  async listActivations(@Req() request?: { userContext?: OrgContext }) {
    // ADR-073：org 只允许来自认证上下文（query 参数 orgId 欺骗路径废弃，§3/§15）。
    return this.policyActivationService.listActivations(
      request?.userContext?.primaryOrgId ?? null,
    );
  }

}