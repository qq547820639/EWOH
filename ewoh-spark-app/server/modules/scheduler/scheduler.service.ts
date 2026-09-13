/**
 * SchedulerService — Strangler Refactor（Task 2）后的 thin facade。
 *
 * 保持原有公开 API 面（方法签名/构造签名）不变，将全部实现委托给 7 个职责
 * 单一的服务（映射表见 scheduler-query.service.ts 等文件头部说明；行为由
 * scheduler-facade-characterization.spec.ts 作为 oracle 锁定）。
 *
 * 保留字段/语义（兼容旧单测的私有成员访问）：
 *   - constraintLoaderService：旧单测构造后注入；RunOrchestrator 经 getter 惰性读取。
 *   - comparePolicyVersion：旧单测会将其替换为 spy；Event 服务经调用时求值的
 *     引用读取，保证替换生效。
 */
import {
  Injectable,
  Inject,
  Logger,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import type {
  SchedulePlan,
  ScheduleAudit,
  SchedulingPlanV2,
  SchedulingRun,
  RouteGraph,
  Route,
  CreateRunRequest,
  ApprovePlanRequest,
  RejectPlanRequest,
  ReplanRequest,
  CalculateRouteRequest,
  TaskCandidatesResponse,
  ListRunsRequest,  ListRunsResponse,
  WorldStateSnapshot,
  SchedulingConflict,
  ConflictsListRequest,
  ConflictsListResponse,
  SchedulingPolicyConfig,
  SchedulingPolicy,
  SchedulingPolicyVersionSummary,
  SchedulingPolicyComparison,
  PlanOverrideRequest,
  PlanOverrideResponse,
  RecordActualsRequest,
  SchedulingEventRequest,
  RouteCandidatesResponse,
  SchedulingExecution,
  ExecutionUpdateRequest,
  ExecutionListResponse,
} from '@shared/api.interface';
import { eq } from 'drizzle-orm';
import { ewohPersonnel } from '@server/database/schema';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { SchedulingContextService } from './scheduling-context.service';
import { TriggerService } from './trigger.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { RoutingService } from './routing.service';
import { EligibilityService } from './eligibility.service';
import { RouteCostProvider } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { OutboxService } from './outbox.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { ConflictService } from './conflict.service';
import { PolicyReplayService } from './policy-replay.service';
import { ExecutionService } from './execution.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { CandidateEngineService } from './candidate-engine.service';
import { ReplanPreviewService } from './replan-preview.service';
import { SchedulerQueryService } from './scheduler-query.service';
import { SchedulerRunOrchestrator } from './scheduler-run-orchestrator.service';
import { SchedulingNarratorService } from './narration/scheduling-narrator.service';
import { SchedulerPlanApplicationService } from './scheduler-plan-application.service';
import { SchedulerReplanApplicationService } from './scheduler-replan-application.service';
import { SchedulerConstraintApplicationService } from './scheduler-constraint-application.service';
import { SchedulerEventApplicationService } from './scheduler-event-application.service';
import { SchedulerDispatchApplicationService } from './scheduler-dispatch-application.service';
import { ExecutionReceiptApplicationService } from './execution-receipt-application.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  private readonly queryService: SchedulerQueryService;
  private readonly runOrchestrator: SchedulerRunOrchestrator;
  private readonly planApplication: SchedulerPlanApplicationService;
  private readonly replanApplication: SchedulerReplanApplicationService;
  private readonly constraintApplication: SchedulerConstraintApplicationService;
  private readonly eventApplication: SchedulerEventApplicationService;
  private readonly dispatchApplication: SchedulerDispatchApplicationService;
  /** 少量只读展示查询（myFieldWork 人员名回填）；业务写路径仍走专职服务。 */
  private readonly db: PostgresJsDatabase;
  /** NO-62c：过期诊断委托目标（PlanService 持有世界快照新鲜度实现）。 */
  private readonly planService: PlanService;

  constructor(
    @Inject(DRIZZLE_DATABASE) db: PostgresJsDatabase,
    requestDatabaseContext: RequestDatabaseContext,
    auditService: AuditService,
    worldStateSnapshotService: WorldStateSnapshotService,
    triggerService: TriggerService,
    solverService: SolverService,
    planService: PlanService,
    routingService: RoutingService,
    eligibilityService: EligibilityService,
    routeCostProvider: RouteCostProvider,
    policyService: SchedulingPolicyService,
    feedbackService: SchedulingFeedbackService,
    outboxService?: OutboxService,
    replanCoordinatorService?: ReplanCoordinatorService,
    metricsService?: SchedulerMetricsService,
    conflictService?: ConflictService,
    policyReplayService?: PolicyReplayService,
    executionService?: ExecutionService,
    // T02 / P0-2：持久化人工约束唯一加载入口。保持为实例字段（旧单测可在构造后
    // 赋值），RunOrchestrator 经 getter 惰性读取，保证后注入的 loader 生效。
    private readonly constraintLoaderService?: ConstraintLoaderService,
    candidateEngineService?: CandidateEngineService,
    replanPreviewService?: ReplanPreviewService,
    /** context 短缓存失效（run 成功后新快照立即对前端可见；可选兼容旧单测）。 */
    private readonly schedulingContextService?: SchedulingContextService,
    /** AI 调度说明层（2026-08-21）：orchestrator 为手动 new，必须在此注入后透传。 */
    @Optional() private readonly narratorService?: SchedulingNarratorService,
    @Optional() receiptService?: ExecutionReceiptApplicationService,
  ) {
    this.db = db;
    // NO-62c：过期诊断委托 PlanService（与审批路径同一实现）。
    this.planService = planService;
    this.queryService = new SchedulerQueryService(
      db,
      worldStateSnapshotService,
      planService,
      routingService,
      policyService,
      feedbackService,
      eligibilityService,
      routeCostProvider,
      candidateEngineService,
      conflictService,
      policyReplayService,
      executionService,
    );
    this.runOrchestrator = new SchedulerRunOrchestrator(
      db,
      requestDatabaseContext,
      triggerService,
      worldStateSnapshotService,
      solverService,
      planService,
      this.schedulingContextService,
      () => this.constraintLoaderService,
      this.narratorService,
    );
    this.planApplication = new SchedulerPlanApplicationService(
      db,
      requestDatabaseContext,
      auditService,
      planService,
      policyService,
      policyReplayService,
      executionService,
    );
    this.replanApplication = new SchedulerReplanApplicationService(planService);
    this.constraintApplication = new SchedulerConstraintApplicationService(
      planService,
      policyService,
    );
    this.eventApplication = new SchedulerEventApplicationService(
      replanCoordinatorService,
      replanPreviewService,
      outboxService,
      metricsService,
      worldStateSnapshotService,
      policyService,
      planService,
      auditService,
      feedbackService,
      // 调用时求值：兼容旧单测（batch10-shadow-eval）构造后替换 svc.comparePolicyVersion 为 spy。
      (...args) => this.comparePolicyVersion(...args),
      receiptService,
    );
    this.dispatchApplication = new SchedulerDispatchApplicationService(
      executionService,
      receiptService,
    );
  }

  // ==========================================================================
  // Legacy 兼容入口 / 只读查询面（QueryService / RunOrchestrator）
  // ==========================================================================

  /** @deprecated 请改用 POST /api/scheduler/runs（保留仅为兼容旧调用方）。 */
  async generatePlans(body?: { idempotencyKey?: string }): Promise<SchedulePlan[]> {
    return this.runOrchestrator.generatePlans(body);
  }

  async getPlans(status?: string, actor?: OrgContext): Promise<SchedulePlan[]> {
    return this.queryService.getPlans(status, actor);
  }

  async getAudit(planId?: string, actor?: OrgContext): Promise<ScheduleAudit[]> {
    return this.queryService.getAudit(planId, actor);
  }

  async createRun(
    body: CreateRunRequest,
    actor?: OrgContext,
  ): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
    return this.runOrchestrator.createRun(body, actor);
  }

  async getRun(runId: string, actor?: OrgContext): Promise<SchedulingRun | null> {
    return this.queryService.getRun(runId, actor);
  }

  async listRuns(params: ListRunsRequest = {}, actor?: OrgContext): Promise<ListRunsResponse> {
    return this.queryService.listRuns(params, actor);
  }

  async getActivePlans(actor?: OrgContext): Promise<SchedulingPlanV2[]> {
    return this.queryService.getActivePlans(actor);
  }

  async getSnapshot(actor?: OrgContext): Promise<WorldStateSnapshot> {
    return this.queryService.getSnapshot(actor);
  }

  /** NO-62c：方案过期诊断（与审批 409 同一实现；委托 PlanService，避免第二套口径）。 */
  async explainPlanStaleness(planId: string, actor?: OrgContext) {
    return this.planService.explainPlanStaleness(planId, actor);
  }

  async getPlanDetail(planId: string, actor?: OrgContext): Promise<SchedulingPlanV2> {
    return this.queryService.getPlanDetail(planId, actor);
  }

  async getPolicy(actor?: OrgContext): Promise<{ policy: SchedulingPolicy; config: SchedulingPolicyConfig }> {
    return this.queryService.getPolicy(actor);
  }

  async listPolicyVersions(actor?: OrgContext): Promise<SchedulingPolicyVersionSummary[]> {
    return this.queryService.listPolicyVersions(actor);
  }

  async comparePolicyVersion(
    configVersion: number,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyComparison> {
    return this.queryService.comparePolicyVersion(configVersion, actor);
  }

  async listPlanConstraintsV2(planId: string, actor?: OrgContext) {
    return this.queryService.listPlanConstraintsV2(planId, actor);
  }

  async getRoutes(actor?: OrgContext): Promise<RouteGraph> {
    return this.queryService.getRoutes(actor);
  }

  async calculateRouteV2(
    body: CalculateRouteRequest,
    actor?: OrgContext,
  ): Promise<Route | RouteCandidatesResponse> {
    return this.queryService.calculateRouteV2(body, actor);
  }

  async getTaskCandidates(taskId: string, actor?: OrgContext): Promise<TaskCandidatesResponse> {
    return this.queryService.getTaskCandidates(taskId, actor);
  }

  async listConflicts(params: ConflictsListRequest = {}, actor?: OrgContext): Promise<ConflictsListResponse> {
    return this.queryService.listConflicts(params, actor);
  }

  async getConflictDetail(conflictId: string, actor?: OrgContext): Promise<SchedulingConflict> {
    return this.queryService.getConflictDetail(conflictId, actor);
  }

  /**
   * 现场作业台只读投影（按人收敛，服务端推导范围）。
   *
   * 关键不变量：范围来自**签名令牌里的账号↔人员绑定**（ctx.personId），
   * 不接受客户端传入 personId。未绑定 → 403 fail-closed，而不是返回全厂数据
   * 或空列表充数（空列表会让工人误以为"我没有任务"）。
   */
  async myFieldWork(actor?: OrgContext): Promise<{
    personId: string;
    /** 绑定人员姓名（展示用；查不到为 null，UI 显示"未知"，不伪造）。 */
    personName?: string | null;
    executions: ExecutionListResponse['executions'];
    total: number;
  }> {
    if (!actor?.primaryOrgId || !actor.userId) {
      throw new ForbiddenException('FIELD_WORK_CONTEXT_REQUIRED');
    }
    const personId = actor.personId?.trim();
    if (!personId) {
      throw new ForbiddenException(
        'FIELD_WORK_PERSON_UNBOUND: 当前账号未绑定业务人员，无法确定"我的任务"。'
          + '请由管理员经 owner 通道绑定（db/runner/create-operator.js --person-id）。',
      );
    }
    const result = await this.queryService.executionList({ personId }, actor);
    // 展示名解析（2026-09-11）：优先直查人员域（executions 为空时也有名字）；
    // db 句柄不可用（单测替身构造）时退回执行记录的回填值，再退 null——
    // 解析不到如实返回 null，UI 显示"未知"，绝不伪造。
    let personName: string | null = result.executions.find((e) => e.personName)?.personName ?? null;
    if (this.db) {
      const [row] = await this.db
        .select({ name: ewohPersonnel.name })
        .from(ewohPersonnel)
        .where(eq(ewohPersonnel.id, personId))
        .limit(1);
      personName = row?.name ?? personName;
    }
    return { personId, personName, executions: result.executions, total: result.total };
  }

  async executionList(
    query: {
      planId?: string; taskId?: string; status?: string; personId?: string;
      limit?: number; offset?: number;
    },
    actor?: OrgContext,
  ): Promise<ExecutionListResponse> {
    return this.queryService.executionList(query, actor);
  }

  // ==========================================================================
  // 方案应用写路径（PlanApplicationService）
  // ==========================================================================

  async confirmPlan(
    planId: string,
    reason: string,
    operator?: string,
    actor?: OrgContext,
  ): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
    return this.planApplication.confirmPlan(planId, reason, operator, actor);
  }

  async rejectPlan(
    planId: string,
    reason: string,
    operator?: string,
    actor?: OrgContext,
  ): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
    return this.planApplication.rejectPlan(planId, reason, operator, actor);
  }

  async approvePlanV2(
    planId: string,
    body: ApprovePlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planApplication.approvePlanV2(planId, body, actor);
  }

  async rejectPlanV2(
    planId: string,
    body: RejectPlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planApplication.rejectPlanV2(planId, body, actor);
  }

  async dispatchPlanV2(
    planId: string,
    actor?: OrgContext,
    wave?: { assignmentIds?: string[] },
  ): Promise<SchedulingPlanV2> {
    return this.planApplication.dispatchPlanV2(planId, actor, wave);
  }

  /** DR-5 方案取消/回滚（standalone_077）：受控部分回退。 */
  async cancelPlanV2(
    planId: string,
    body: { reason?: string },
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planApplication.cancelPlanV2(planId, body, actor);
  }

  async applyOverrides(
    planId: string,
    body: PlanOverrideRequest,
    actor?: OrgContext,
  ): Promise<PlanOverrideResponse> {
    return this.planApplication.applyOverrides(planId, body, actor);
  }

  async comparePlansV2(
    planId: string,
    otherPlanId: string,
  ): Promise<Record<string, unknown>> {
    return this.planApplication.comparePlansV2(planId, otherPlanId);
  }

  async activatePolicyVersion(
    configVersion: number,
    body: { approver?: string; reason?: string },
    actor?: OrgContext,
  ): Promise<{ config: SchedulingPolicyConfig }> {
    return this.planApplication.activatePolicyVersion(configVersion, body, actor);
  }

  // ==========================================================================
  // 重排 / 约束 / 策略候选（委托 Replan / Constraint 应用服务）
  // ==========================================================================

  async replanV2(
    planId: string,
    body: ReplanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.replanApplication.replanV2(planId, body, actor);
  }

  async deactivateConstraintV2(
    constraintId: string,
    actor?: OrgContext,
    reason = '',
  ) {
    return this.constraintApplication.deactivateConstraintV2(constraintId, actor, reason);
  }

  async registerPolicyVersion(
    config: SchedulingPolicyConfig,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyConfig> {
    return this.constraintApplication.registerPolicyVersion(config, actor);
  }

  // ==========================================================================
  // 事件驱动 / 反馈闭环（EventApplicationService）
  // ==========================================================================

  async injectSchedulingEvent(
    body: SchedulingEventRequest,
    actor?: OrgContext,
  ): Promise<{
    run: SchedulingRun | null;
    plans: SchedulingPlanV2[];
    debounced: boolean;
    cascaded: string[];
    approval?: import('@shared/api.interface').ReplanApprovalDecision;
    preview?: import('@shared/api.interface').ReplanPreviewResult | null;
  }> {
    return this.eventApplication.injectSchedulingEvent(body, actor);
  }

  async recordTaskActuals(
    input: RecordActualsRequest,
    actor?: OrgContext,
  ): Promise<{ ok: boolean; matched: boolean }> {
    return this.eventApplication.recordTaskActuals(input, actor);
  }

  // ==========================================================================
  // 执行领域更新（DispatchApplicationService）
  // ==========================================================================

  async executionUpdate(
    assignmentId: string,
    body: ExecutionUpdateRequest,
    actor?: OrgContext,
  ): Promise<SchedulingExecution> {
    return this.dispatchApplication.executionUpdate(assignmentId, body, actor);
  }
}
