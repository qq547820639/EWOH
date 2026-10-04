import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohSchedulingPlanAssignment,
  ewohSchedulingConstraint,
  ewohSimulationRun,
  ewohAssignmentEvent,
  ewohResourceReservation,
  ewohProductionTask,
} from '@server/database/schema';
import { eq, asc, and, inArray, desc, isNull, or, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  PlanStatus,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import {
  cancelAssignmentByCAS,
  projectAssignmentsApproved,
  projectAssignmentsCancelled,
} from './scheduling-assignment.lifecycle';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { PostgresJsDatabase as PostgresJsDatabaseType } from '@lark-apaas/fullstack-nestjs-core';
import type { OrgContext } from '../shared/org-context.interceptor';
import { SolverService, type SolverConstraint } from './solver.service';
import {
  WorldStateSnapshotService,
  type PlanStalenessReport,
} from './world-state.service';
import { DispatchCoordinatorService } from './dispatch-coordinator.service';
import { projectPlanDecisionRecords, projectPlanApprovalDecision } from './decision-projection';
import { appendPlanDecisionRecords } from './decision-ledger';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { isSoftConstraintType } from './constraints';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { OutboxService } from './outbox.service';
import { SimulationService } from '../simulation/simulation.service';
import { buildPlanLayoutParameters } from './pre-approval-simulation';
import { assertPlanTenantVisible } from './plan-tenant-guard';
import { TaskService } from '../task/task.service';

/** 并发 replan 竞态识别：drizzle 把驱动原生错误包在 DrizzleQueryError.cause 上
 * （cause = postgres PostgresError，带 code/constraint_name）。
 * ewoh_schedule_plan.plan_id 唯一键冲突（23505）= 另一并发 replan 已基于同一
 * plan.version 抢先落库 replacement，属确定性竞态结局（转 409），非内部错误。 */
export function isPlanIdUniqueViolation(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { code?: string; constraint_name?: string };
    if (
      e.code === '23505' &&
      typeof e.constraint_name === 'string' &&
      e.constraint_name.includes('ewoh_schedule_plan_plan_id')
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 方案服务：持久化方案、审批/拒绝/下发/重排/对比。 */
@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
    private readonly solverService: SolverService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly dispatchCoordinator: DispatchCoordinatorService,
    private readonly schedulingPolicyService: SchedulingPolicyService,
    // T02 / P0-1（G1）：观测反馈（必选；生产路径始终注入）。
    private readonly feedbackService: SchedulingFeedbackService,
    // T02 / P0-2：持久化人工约束唯一加载入口（必选）。
    private readonly constraintLoaderService: ConstraintLoaderService,
    // T04 / P1-6：PLAN_STALE 事件化（必选）。
    private readonly outboxService: OutboxService,
    // T04 / P1-6：stale approve → scoped replan（forwardRef 打破 Plan↔Replan 循环依赖）。
    @Inject(forwardRef(() => ReplanCoordinatorService))
    private readonly replanCoordinator: ReplanCoordinatorService,
    // NO-12s / ADR-042：审批前自动布局仿真预验证（advisory；模块装配生产必达，
    // Optional 仅兼容直接构造的单测 seams——缺装配时显式 warn 跳过）。
    @Optional()
    private readonly simulationService?: SimulationService,
    // DR-5：取消/回滚路径的任务状态机操作（rollback_dispatch）。Optional 仅
    // 兼容直接构造的单测 seams——生产装配必达；cancelPlan 对缺装配 fail-closed。
    @Optional()
    private readonly taskService?: TaskService,
  ) {}

  /** 持久化一个 V2 方案（ewoh_schedule_plan + 分配明细）。 */
  async persistPlan(
    plan: SchedulingPlanV2,
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    // NO-12y / ADR-048：Decision 契约唯一投影点——先投影后落库（所有持久化
    // 方案必带 decisionRecords 或显式缺口计数 decisionProjectionIssues，§33）。
    const projected = projectPlanDecisionRecords(plan, ctx);
    plan.decisionRecords = projected.records;
    plan.decisionProjectionIssues = projected.issues;
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db.insert(ewohSchedulePlan).values({
          planId: plan.planId,
          planName: plan.planName ?? plan.planId,
          strategy: 'scheduling_v2',
          status: plan.status,
          version: plan.version,
          snapshotVersion: plan.snapshotVersion,
          triggerType: plan.trigger.type,
          triggerEntityId: plan.trigger.entityId ?? null,
          metricsJson: plan.metrics as unknown as Record<string, unknown>,
          baselineDeltaJson: plan.baselineDelta,
          violationsJson: plan.violations,
          policyVersion: plan.policyVersion ?? null,
          solverVersion: plan.solverVersion ?? null,
          // standalone_030_solver_activation（Task A / P0）：实际求解器状态/回退原因持久化。
          solverStatus: plan.solverStatus ?? null,
          fallbackReason: plan.fallbackReason ?? null,
          horizonMinutes: plan.horizonMinutes ?? null,
          scoreBreakdownJson: (plan.scoreBreakdown ?? null) as unknown as Record<string, unknown> | null,
          // Phase 2 / P2-T2：实际投放的 8 权重快照（确定性 replay）。
          weightsJson: plan.weights ?? null,
          // T02 / P0-2：求解所用 effective constraints 快照 + 稳定哈希（standalone_023）。
          constraintsJson: (plan.constraints ?? []) as unknown as Record<string, unknown>[],
          effectiveConstraintsHash: plan.effectiveConstraintsHash ?? null,
          // NO-12y / ADR-048：Canonical DecisionRecord[] 持久化（standalone_050；
          // 决策历史单一事实源，§12/§18；旧行 NULL=未投影）。
          decisionRecordsJson: (projected.records.length > 0
            ? projected.records
            : null) as unknown as Record<string, unknown>[] | null,
          // standalone_025_scheduler_rls：租户隔离（null=全局/存量行，policy 放行）。
          orgId: ctx.primaryOrgId || null,
          // B5 审批独立性（standalone_069）：生成操作者取服务端权威口径 actor.userId
          //（前端 operator 可伪造，不参与回避比较）。NULL=存量/legacy 行。
          createdBy: ctx.userId || null,
          createdAt: new Date(plan.createdAt),
        });

        if (plan.assignments.length > 0) {
          await this.db.insert(ewohSchedulingPlanAssignment).values(
            plan.assignments.map((a) => ({
              assignmentId: a.assignmentId,
              planId: plan.planId,
              taskId: a.taskId,
              personId: a.personId,
              deviceId: a.deviceId,
              stationId: a.stationId,
              zoneId: a.zoneId,
              plannedStart: a.plannedStart ? new Date(a.plannedStart) : null,
              plannedEnd: a.plannedEnd ? new Date(a.plannedEnd) : null,
              routeId: a.routeId,
              status: a.status,
              explanationJson: {
                reasons: a.reasons,
                alternatives: a.alternatives,
              },
              etaSeconds: a.etaSeconds ?? null,
              distanceMeters: a.distanceMeters ?? null,
              riskLevel: a.riskLevel ?? null,
              scoreBreakdownJson: (a.scoreBreakdown ?? null) as unknown as Record<string, unknown> | null,
              decisionTraceJson: (a.decisionTrace ?? null) as unknown as Record<string, unknown> | null,
              version: 1,
              orgId: ctx.primaryOrgId || null,
              createdBy: ctx.userId,
            })),
          );
        }
      },
    );

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.persist',
      entityType: 'schedule_plan',
      entityId: plan.planId,
      after: { version: plan.version, status: plan.status },
    });
    return plan;
  }

  /** 读取完整方案（含分配明细）。actor 提供时执行租户可见性守卫（ADR-071）。 */
  async getPlan(planId: string, actor?: OrgContext): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    assertPlanTenantVisible(plan.orgId, actor, planId);

    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(eq(ewohSchedulingPlanAssignment.planId, planId))
      .orderBy(asc(ewohSchedulingPlanAssignment.taskId));

    const result = await this.toPlanV2(plan, assignments);
    return this.attachPreApprovalSimulation(result);
  }

  /**
   * M03：列出当前生效方案（active 状态 shadow/proposed/approved/dispatched/executing），
   * 按创建时间倒序。供 ReplanPreviewService 基线对比（预览只读，不落库）。
   * R-5 N+1 修复：assignments 一次 inArray 批量加载（原每方案一次查询）。
   */
  async listActivePlans(actor?: OrgContext): Promise<SchedulingPlanV2[]> {
    const activeStatuses = [
      'draft',
      'shadow',
      'proposed',
      'approved',
      'dispatched',
      'executing',
    ];
    // NEST-039/152（2026-08-17）：活跃方案列表按 actor org 过滤（org 匹配或
    // NULL 存量）——replan preview 基线此前可取自他租户方案。
    const rows = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(
        and(
          inArray(ewohSchedulePlan.status, activeStatuses),
          actor
            ? or(
                isNull(ewohSchedulePlan.orgId),
                eq(ewohSchedulePlan.orgId, actor.primaryOrgId),
              )
            : undefined,
        ),
      )
      .orderBy(desc(ewohSchedulePlan.createdAt));
    if (rows.length === 0) return [];

    const assignmentsByPlan = await this.loadAssignmentsBatched(
      rows.map((row) => row.planId),
    );

    const plans: SchedulingPlanV2[] = [];
    for (const row of rows) {
      try {
        plans.push(
          await this.toPlanV2(row, assignmentsByPlan.get(row.planId) ?? []),
        );
      } catch (err) {
        this.logger.warn(
          `listActivePlans: skip ${row.planId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return plans;
  }

  /**
   * R-5 N+1 修复：按 planId 批量加载分配明细（一次查询 + 内存分组），
   * 保持 per-plan taskId 升序（与原逐方案查询一致）。
   */
  private async loadAssignmentsBatched(
    planIds: string[],
  ): Promise<Map<string, Array<typeof ewohSchedulingPlanAssignment.$inferSelect>>> {
    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(inArray(ewohSchedulingPlanAssignment.planId, planIds))
      .orderBy(
        asc(ewohSchedulingPlanAssignment.planId),
        asc(ewohSchedulingPlanAssignment.taskId),
      );
    const byPlan = new Map<string, Array<typeof ewohSchedulingPlanAssignment.$inferSelect>>();
    for (const assignment of assignments) {
      const list = byPlan.get(assignment.planId) ?? [];
      list.push(assignment);
      byPlan.set(assignment.planId, list);
    }
    return byPlan;
  }

  /**
   * R-5 N+1 修复：批量加载一组方案（含分配明细），供 listRuns 等列表端点使用
   * （原实现逐方案调 getPlan → 每方案 2 次查询）。
   *
   * slim=true 时剥离重量级字段（decisionTrace ~36KB/assignment、alternatives、
   * scoreBreakdown、weights、decisionRecords），把响应体从几十 MB 压到 KB 级——
   * 与 createRun 响应瘦身（scheduler-run-orchestrator）同款策略；
   * 前端列表页按需 GET /plans/:planId 获取完整数据。
   */
  async listPlansBatched(
    planIds: string[],
    opts: { slim?: boolean } = {},
  ): Promise<SchedulingPlanV2[]> {
    if (planIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(inArray(ewohSchedulePlan.planId, planIds))
      .orderBy(desc(ewohSchedulePlan.createdAt));
    if (rows.length === 0) return [];
    const assignmentsByPlan = await this.loadAssignmentsBatched(planIds);
    const plans: SchedulingPlanV2[] = [];
    for (const row of rows) {
      try {
        plans.push(
          await this.toPlanV2(
            row,
            assignmentsByPlan.get(row.planId) ?? [],
            opts.slim === true,
          ),
        );
      } catch (err) {
        this.logger.warn(
          `listPlansBatched: skip ${row.planId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return plans;
  }

  /**
   * 审批方案：校验 version + snapshotVersion，过期则抛 PLAN_STALE。
   * Phase 3 / P3-T4：若方案会改变安全关键任务的当前执行/锁定分配 → 拒绝 SAFETY_CRITICAL_LOCKED。
   */
  async approvePlan(
    planId: string,
    body: { version: number; snapshotVersion: string; operator?: string; reason?: string },
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    // ADR-071：变面租户守卫（反枚举 404，先于一切业务校验；与 RLS 语义等价）。
    assertPlanTenantVisible(plan.orgId, ctx, planId);

    // P4-SHADOW：Shadow Plan 服务端 hard guard——不可 approve（不靠前端隐藏按钮）。
    if (plan.isShadow) {
      throw new ConflictException('SHADOW_PLAN_GUARD: shadow plan cannot be approved');
    }

    const approvablePlanStatuses = new Set(['draft', 'shadow', 'proposed']);
    if (!approvablePlanStatuses.has(plan.status ?? '')) {
      throw new ConflictException(
        `PLAN_NOT_APPROVABLE: 当前状态 ${plan.status}（仅 draft/shadow/proposed 可审批）`,
      );
    }

    // B5 审批独立性（standalone_069 / 决策单 D-3 核实）：生成人回避——
    // 比较用服务端权威口径 actor.userId（body.operator 可伪造，不参与）。
    // createdBy 为 NULL（存量/legacy 行）时放行，避免历史方案被永久锁死。
    if (plan.createdBy && ctx.userId && plan.createdBy === ctx.userId) {
      throw new ForbiddenException(
        `SELF_APPROVAL_FORBIDDEN: plan ${planId} was created by the requesting operator (B5 审批独立性)`,
      );
    }

    if (plan.version !== body.version) {
      // T04 / P1-6：PLAN_STALE 事件化 + scoped replan（cause=PLAN_STALE）后仍拒绝审批。
      await this.notifyStalePlan(planId, ctx);
      throw new ConflictException('PLAN_STALE');
    }
    try {
      // NO-64a：把 planId 传下去，让闸门按"事实变化 vs 证据老化"分档——
      // 与方案无关的设备沉默不再阻断审批，而方案依赖的资源证据过期仍然 fail-closed。
      await this.worldStateSnapshotService.assertFreshForApprove(
        body.snapshotVersion,
        ctx,
        planId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'PLAN_STALE' || msg.includes('PLAN_STALE')) {
        // NO-62c：把"过期"变成**可处置的诊断**——409 体里带上差异事实
        // （哪些实体变了、哪些是本方案自身造成的），页面据此告诉审批人
        // "变了什么、要不要重排"，而不是只弹一句"方案已过期"。
        const diagnosis = await this.safeDescribeStaleness(
          body.snapshotVersion,
          ctx,
          planId,
        );
        await this.notifyStalePlan(planId, ctx);
        // 注意形状：全局异常过滤器只透传 `{ error: { code, message, ... } }` 形态的
        // 结构化响应（`extractStructuredResponse`），所以诊断必须挂在 `error` 下，
        // 否则会被改写成一串纯文本（实测：页面拿不到差异明细）。
        throw new ConflictException({
          // 顶层 message 保持 `PLAN_STALE`：既有调用方/测试按 message 判定过期，
          // 不能因为"加了结构化明细"就把裸状态码语义改掉（前端 isPlanStaleError 依赖它）。
          message: 'PLAN_STALE',
          error: {
            code: 'PLAN_STALE',
            message: 'PLAN_STALE',
            details: diagnosis?.summary ?? '方案绑定的世界快照与当前状态不一致',
            // NO-64a：机器可读的阻断原因（CONTENT_CHANGED = 事实变了；EVIDENCE_STALE = 依赖资源证据过期）
            stalenessReason: diagnosis?.reason ?? null,
            planStaleness: diagnosis,
            replanAvailable: true,
          },
        });
      }
      throw err;
    }
    // Phase 3 / P3-T4：方案不得改变安全关键任务的锁定分配。
    await this.assertNoSafetyCriticalChange(planId, 'approve', [], ctx);

    // NO-12s / ADR-042：审批前自动布局仿真预验证（advisory——仿真失败/跳过
    // 显式留痕，绝不阻断审批：审批仍是人工决策门，§13/§2）。
    const preApprovalSimulation = await this.runPreApprovalSimulation(planId, ctx);

    // NO-64b（审计边界修复）：确认人一律记**认证主体** `ctx.userId`。
    //
    // 为什么不能记 `body.operator`：`confirmedBy` 是"独立审批"这条安全闸门的输入
    // （`hasIndependentApproval(plan)` 比较 `createdBy !== confirmedBy`，回执授权
    // `RECEIPT_PLAN_NOT_AUTHORIZED` 也读它）。写客户端自报字段 = 审批人可以用别人的
    // 名字落库、也可以把"自己生成、自己审批"伪装成独立审批（本轮 e2e 实测：
    // created=admin、confirmed=admin 由自报造成 → 回执被正确拒绝，但根因是入库口径）。
    // 自报操作者只作为**声明**留在审计里（可追溯，不影响判定）。
    const op = ctx.userId;
    const claimedOperator = body.operator?.trim() || null;
    const approvalReason = claimedOperator && claimedOperator !== op
      ? `${body.reason ?? ''}（自报操作者 ${claimedOperator}）`
      : (body.reason ?? '');
    const now = new Date();
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const [updatedPlan] = await this.db
          .update(ewohSchedulePlan)
          .set({
            status: 'approved',
            confirmedBy: op,
            confirmedAt: now,
            confirmReason: approvalReason,
          })
          .where(and(
            eq(ewohSchedulePlan.planId, planId),
            eq(ewohSchedulePlan.version, plan.version),
            eq(ewohSchedulePlan.status, plan.status),
          ))
          .returning({ id: ewohSchedulePlan.id });
        if (!updatedPlan) {
          throw new ConflictException('PLAN_CONCURRENT_TRANSITION');
        }

        // V279：审批决策向分配行的投影写入收进具名入口（谓词与状态值形状逐字保持）。
        await projectAssignmentsApproved(this.db, { planId, orgId: plan.orgId ?? null });

        await this.insertAudit(planId, 'approve', op, approvalReason, now, ctx.primaryOrgId);
      },
    );

    await this.auditService.appendAuditLog({
      actorId: op,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.approve',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status, version: plan.version },
      after: { status: 'approved', preApprovalSimulation },
      reason: body.reason,
    });
    // NO-13h / ADR-057：plan_approval 决策契约留痕（Decision Catalog kind #2；
    // 投影失败显式 log 绝不阻断审批主流程，§2 人审门语义不变）。
    await this.appendPlanApprovalDecision(
      planId, plan.version, 'approved', op, body.reason, ctx, now,
    );
    this.recordAcceptanceFeedback(planId, true, ctx);
    return this.getPlan(planId);
  }

  /**
   * NO-13h / ADR-057：审批决策追加进方案决策台账（decision_records_json）。
   * 投影缺口/回写失败显式 log 留痕（§33 不吞异常），不阻断审批主流程。
   */
  private async appendPlanApprovalDecision(
    planId: string,
    version: number,
    outcome: 'approved' | 'rejected',
    operator: string,
    reason: string | undefined,
    ctx: OrgContext,
    now: Date,
  ): Promise<void> {
    const projected = projectPlanApprovalDecision(planId, version, outcome, operator, reason, ctx, now);
    if (!projected.record) {
      this.logger.warn(
        `plan approval decision projection skipped for ${planId}: ${projected.issues.join(', ')}`,
      );
      return;
    }
    try {
      // ADR-062 决策 2（§31）：台账读-追加-回写单一实现。
      await appendPlanDecisionRecords(this.db, planId, [projected.record]);
    } catch (err) {
      this.logger.warn(
        `plan approval decision append failed for ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * NO-12s / ADR-042：审批前自动布局仿真预验证（advisory）。
   * 从方案分配 + 快照工位坐标推导人员移动图 → SimulationService 确定性
   * layout 评估器独立重算方案行程成本（runId 确定性幂等回读；scenarioId
   * = plan:<planId> 台账可关联）。仿真装配缺失/参数不可推导/评估失败 →
   * 显式留痕（error/skippedReason），绝不阻断审批。
   */
  private async runPreApprovalSimulation(
    planId: string,
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2['preApprovalSimulation']> {
    const runId = `plan-approval:${planId}`;
    if (!this.simulationService) {
      this.logger.warn(`pre-approval simulation skipped（SimulationService 未装配）${planId}`);
      return { runId, status: 'skipped', skippedReason: 'simulation_service_unavailable' };
    }
    try {
      const assignmentRows = await this.db
        .select()
        .from(ewohSchedulingPlanAssignment)
        .where(eq(ewohSchedulingPlanAssignment.planId, planId));
      const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
      const parameters = buildPlanLayoutParameters(
        assignmentRows.map((row) => ({
          personId: row.personId,
          stationId: row.stationId,
          plannedStart: row.plannedStart ? row.plannedStart.toISOString() : null,
        })),
        snapshot.stations.map((station) => ({
          id: station.id,
          x: station.x,
          y: station.y,
        })),
      );
      if (!parameters) {
        return { runId, status: 'skipped', skippedReason: 'no_multi_station_route' };
      }
      const response = await this.simulationService.run(
        {
          runId,
          kind: 'layout',
          baseRef: { snapshotVersion: 0, scenarioId: `plan:${planId}` },
          parameters: parameters as unknown as Record<string, unknown>,
        },
        ctx.primaryOrgId,
      );
      const run = response.run as Record<string, unknown>;
      const results = (run.results ?? {}) as Record<string, unknown>;
      if (run.status === 'failed') {
        return { runId, status: 'failed', error: String(run.failureReason ?? 'simulation_failed') };
      }
      return {
        runId,
        status: String(run.status ?? 'completed'),
        totalTravelDistanceM: typeof results.totalTravelDistance === 'number'
          ? results.totalTravelDistance
          : undefined,
        routesCount: Array.isArray(results.routes) ? results.routes.length : undefined,
        engineVersion: typeof run.engineVersion === 'string' ? run.engineVersion : undefined,
      };
    } catch (error) {
      this.logger.warn(
        `pre-approval simulation failed ${planId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { runId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** getPlan 附审批前预验证结果（runId 确定性读取台账；无运行 → 不附加字段）。 */
  private async attachPreApprovalSimulation(
    plan: SchedulingPlanV2,
  ): Promise<SchedulingPlanV2> {
    try {
      // ewoh_simulation_run 唯一键是 (org_id, run_id)——只按 run_id 读会命中
      // 他租户的同名运行（2026-09-10 org 谓词审计）；按方案自身租户收敛。
      const [run] = await this.db
        .select()
        .from(ewohSimulationRun)
        .where(and(
          eq(ewohSimulationRun.runId, `plan-approval:${plan.planId}`),
          plan.orgId ? eq(ewohSimulationRun.orgId, plan.orgId) : undefined,
        ))
        .limit(1);
      if (!run) return plan;
      const results = (run.resultsJson ?? {}) as Record<string, unknown>;
      return {
        ...plan,
        preApprovalSimulation: {
          runId: run.runId,
          status: run.status,
          totalTravelDistanceM: typeof results.totalTravelDistance === 'number'
            ? results.totalTravelDistance
            : undefined,
          routesCount: Array.isArray(results.routes) ? results.routes.length : undefined,
          engineVersion: run.engineVersion,
          error: run.failureReason ?? undefined,
        },
      };
    } catch (error) {
      this.logger.warn(
        `attach pre-approval simulation failed ${plan.planId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return plan;
    }
  }

  /**
   * NO-62c：查询方案是否过期 + **为什么**（只读，供页面/运维/审批前预检）。
   *
   * 与审批路径共用同一判定实现（`describeStaleness`），因此页面看到的差异
   * 就是审批时 409 里那份差异——不会出现"页面说新鲜、审批说过期"的第二套口径。
   */
  async explainPlanStaleness(
    planId: string,
    ctx?: OrgContext,
  ): Promise<{
    planId: string;
    status: string;
    version: number;
    snapshotVersion: string;
    stale: boolean;
    staleness: PlanStalenessReport;
    replanAvailable: boolean;
    checkedAt: string;
  }> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    // ADR-071：变面租户守卫（无 ctx = 内部可信流，RLS 继续兜底）。
    assertPlanTenantVisible(plan.orgId, ctx, planId);
    const staleness = await this.worldStateSnapshotService.describeStaleness(
      String(plan.snapshotVersion ?? ''),
      ctx,
      undefined,
      planId,
    );
    return {
      planId,
      status: String(plan.status ?? ''),
      version: Number(plan.version ?? 0),
      snapshotVersion: String(plan.snapshotVersion ?? ''),
      // 只有"待审批/已审批"的方案才谈得上过期与重排（终态方案无需处置）。
      stale: staleness.stale,
      staleness,
      replanAvailable: ['draft', 'shadow', 'approved', 'rejected', 'cancelled'].includes(
        String(plan.status ?? ''),
      ),
      checkedAt: staleness.checkedAt,
    };
  }

  /** 诊断失败绝不影响审批拒绝语义（拿不到差异也要拒绝，只是文案降级）。 */
  private async safeDescribeStaleness(
    snapshotVersion: string,
    ctx: OrgContext | undefined,
    planId: string,
  ): Promise<PlanStalenessReport | null> {
    try {
      return await this.worldStateSnapshotService.describeStaleness(
        snapshotVersion,
        ctx,
        undefined,
        planId,
      );
    } catch (err) {
      this.logger.warn(
        `describeStaleness failed for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * NO-62c：stale approve 的**持久化**留痕 + 显式补偿入口。
   *
   * 本轮审计烧掉的两个真实缺陷（都不是"缺功能"）：
   *   1. **写入被回滚**：本方法在 approve 内被调用，而 approve 随后抛 409；
   *      `OrgContextInterceptor` 把请求包在一个事务里，异常 → 整体回滚 →
   *      `stale_plan` 事件**从未真正落库**（"事件化"是空头承诺）。
   *      现在经 `runDetachedTransaction` 在独立事务里提交（错误路径上的事实必须存活）。
   *   2. **声称的补偿不存在**：原注释说"重排由 outbox 消费者异步执行"，但
   *      **没有任何消费者**把 `stale_plan` 变成重排；而 fire-and-forget 的
   *      `handleTrigger` 跑在被中止的请求事务里（求解白跑 + 写入丢失，还占着连接）。
   *      现在不再假装自动补偿：过期诊断 + 差异明细随 409 返回，页面一键重排
   *      （`POST /plans/:id/replan`）与 API 调用是**唯一的、显式的、可提交的**重排入口。
   * 观测型：留痕失败仅记日志，不改变审批拒绝语义（PLAN_STALE 仍然抛异常）。
   */
  private async notifyStalePlan(
    planId: string,
    ctx: OrgContext,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    const enqueue = async (executor?: PostgresJsDatabase) =>
      this.outboxService.enqueue(
        'stale_plan',
        planId,
        { planId, reason: 'approve rejected: PLAN_STALE', occurredAt },
        ctx.primaryOrgId || null,
        undefined,
        { entityType: 'schedule_plan', planId, occurredAt, ...(executor ? { executor } : {}) },
      );
    try {
      // 独立事务：即使本请求随后抛 409 回滚，事件仍在。
      // 替身/旧上下文没有该方法时退回同事务入队（金样本 fixture 走这条；
      // 生产装配的 RequestDatabaseContext 一定实现它）。
      if (typeof this.requestDatabaseContext?.runDetachedTransaction === 'function') {
        await this.requestDatabaseContext.runDetachedTransaction(
          buildGucSettings(ctx),
          async (db) => {
            await enqueue(db as PostgresJsDatabase);
          },
        );
      } else {
        await enqueue();
      }
    } catch (err) {
      this.logger.warn(
        `stale plan notification failed for ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 观测型：记录审批验收反馈。失败仅记日志，不影响审批流程。 */
  private recordAcceptanceFeedback(
    planId: string,
    accepted: boolean,
    ctx: OrgContext,
  ): void {
    this.feedbackService
      .recordAcceptance(planId, accepted, ctx)
      .catch((err) => {
        this.logger.warn(
          `scheduling feedback acceptance skipped for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  async rejectPlan(
    planId: string,
    body: { operator?: string; reason?: string },
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    // ADR-071：变面租户守卫（反枚举 404；与 RLS 语义等价）。
    assertPlanTenantVisible(plan.orgId, ctx, planId);

    const rejectablePlanStatuses = new Set(['draft', 'shadow', 'proposed']);
    if (!rejectablePlanStatuses.has(plan.status ?? '')) {
      throw new ConflictException(
        `PLAN_NOT_REJECTABLE: 当前状态 ${plan.status}（仅 draft/shadow/proposed 可拒绝）`,
      );
    }

    // 同上：确认人 = 认证主体（自报操作者只进审计声明）。
    const op = ctx.userId;
    const claimedOperator = body.operator?.trim() || null;
    const rejectReason = claimedOperator && claimedOperator !== op
      ? `${body.reason ?? ''}（自报操作者 ${claimedOperator}）`
      : (body.reason ?? '');
    const now = new Date();
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const [updatedPlan] = await this.db
          .update(ewohSchedulePlan)
          .set({
            status: 'rejected',
            confirmedBy: op,
            confirmedAt: now,
            confirmReason: rejectReason,
          })
          .where(and(
            eq(ewohSchedulePlan.planId, planId),
            eq(ewohSchedulePlan.version, plan.version),
            eq(ewohSchedulePlan.status, plan.status),
          ))
          .returning({ id: ewohSchedulePlan.id });
        if (!updatedPlan) {
          throw new ConflictException('PLAN_CONCURRENT_TRANSITION');
        }

        // V279：拒绝决策向分配行的投影写入收进具名入口（同上，行为零变化）。
        await projectAssignmentsCancelled(this.db, { planId, orgId: plan.orgId ?? null });

        await this.insertAudit(planId, 'reject', op, rejectReason, now, ctx.primaryOrgId);
      },
    );

    await this.auditService.appendAuditLog({
      actorId: op,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.reject',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status },
      after: { status: 'rejected' },
      reason: body.reason,
    });
    // NO-13h / ADR-057：reject 决策同样契约留痕（Decision History 完整性，§12）。
    await this.appendPlanApprovalDecision(
      planId, plan.version, 'rejected', op, body.reason, ctx, now,
    );
    return this.getPlan(planId);
  }

  /**
   * DR-5 方案取消/回滚（standalone_077）：dispatched/executing/approved 方案的
   * 受控回退。部分回滚语义（物理执行不可撤销，如实回报）：
   *  - 可回退 assignment：proposed/approved/dispatched/acknowledged（任务处于
   *    pending_dispatch/dispatched/received 且未开始执行）→ assignment=cancelled、
   *    释放其预占、任务 rollback_dispatch 回 pending_dispatch（重新可排程）；
   *  - 不可回退 assignment：executing/paused/exception/completed/failed/blocked →
   *    保持原状并列入 irreversibleAssignmentIds（现场处置，不静默吞掉）；
   *  - 方案状态 CAS → cancelled（并发双取消守卫），取消事实落列 + 审计 +
   *    PlanCancelled outbox 事件（SSE 实时可见）。
   */
  async cancelPlan(
    planId: string,
    body: { reason?: string },
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const reason = (body.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException('取消原因必填（reason）：回滚必须可解释、可审计。');
    }
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    assertPlanTenantVisible(plan.orgId, ctx, planId);
    const cancellablePlanStatuses = new Set(['approved', 'dispatched', 'executing']);
    if (!cancellablePlanStatuses.has(plan.status ?? '')) {
      throw new ConflictException(
        `PLAN_NOT_CANCELLABLE: 当前状态 ${plan.status}（仅 approved/dispatched/executing 可取消；终态不可逆）`,
      );
    }
    const op = ctx.userId;
    const now = new Date();

    // 分类在事务外只读、事务内复查并按 assignment 逐条 CAS——分派与取消的
    // 边界判定是正确性关键，显式分区（与 dispatch 同纪律）。
    const cancellableAssignmentStatuses = new Set([
      'proposed', 'approved', 'dispatched', 'acknowledged',
    ]);
    // 任务可回退状态（task.yaml rollback_before_start 条件）：未开始执行。
    const rollbackableTaskStatuses = new Set(['pending_dispatch', 'dispatched', 'received']);

    const result = await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(eq(ewohSchedulingPlanAssignment.planId, planId));

        const cancelled: Array<typeof ewohSchedulingPlanAssignment.$inferSelect> = [];
        const irreversible: Array<typeof ewohSchedulingPlanAssignment.$inferSelect> = [];
        for (const a of assignments) {
          if (cancellableAssignmentStatuses.has(a.status)) cancelled.push(a);
          else irreversible.push(a);
        }

        const returnedTaskIds: string[] = [];
        // 遍历快照而非数组本身：下面 CAS 落空的那一项要从 cancelled 里摘掉。
        // 不剪枝 ⇒ cancelledAssignmentIds 同时含"真取消成"与"没取消成"两种项，
        // 而 `scheduler-plan-application.service.ts:345-348` 拿这份清单去标执行跟踪，
        // 于是库里留下 assignment=executing 而 execution=CANCELLED 的投影分叉（CCAS-01，V320）。
        for (const a of [...cancelled]) {
          // assignment → cancelled（逐条 CAS：状态已变则该条不可回退，转入 irreversible）。
          const updated = await cancelAssignmentByCAS(this.db, {
            assignmentId: a.assignmentId,
            fromStatus: a.status,
          });
          if (updated.length === 0) {
            irreversible.push(a);
            cancelled.splice(cancelled.indexOf(a), 1);
            continue;
          }
          await this.db.insert(ewohAssignmentEvent).values({
            eventId: `EVT-${randomUUID()}`,
            assignmentId: a.assignmentId,
            taskId: a.taskId ?? null,
            personId: a.personId ?? null,
            deviceId: a.deviceId ?? null,
            fromStatus: a.status,
            toStatus: 'cancelled',
            actor: op,
            reason: `plan cancelled: ${reason.slice(0, 200)}`,
          });
          // 释放该 assignment 的预占（部分回滚只释放被取消项；已完成项保留台账）。
          await this.db
            .update(ewohResourceReservation)
            .set({ status: 'released' })
            .where(
              and(
                eq(ewohResourceReservation.planId, planId),
                eq(ewohResourceReservation.assignmentId, a.assignmentId),
              ),
            );
          // 任务回退：dispatched/received → pending_dispatch（重新可排程）。
          if (a.taskId) {
            const [task] = await this.db
              .select({ status: ewohProductionTask.status })
              .from(ewohProductionTask)
              .where(eq(ewohProductionTask.id, a.taskId))
              .limit(1);
            if (task && rollbackableTaskStatuses.has(task.status ?? '')) {
              if (task.status === 'dispatched' || task.status === 'received') {
                if (!this.taskService) {
                  throw new InternalServerErrorException(
                    'PLAN_CANCEL_TASK_SERVICE_MISSING: 任务回退需要 TaskService 装配（生产模块必达）',
                  );
                }
                await this.taskService.transitionTaskState(a.taskId, 'rollback_dispatch', ctx);
              }
              returnedTaskIds.push(a.taskId);
            }
          }
        }

        // 方案状态 CAS → cancelled（并发守卫：另一取消/状态变更已发生则 409）。
        const planUpdated = await this.db
          .update(ewohSchedulePlan)
          .set({
            status: 'cancelled',
            cancelledReason: reason,
            cancelledBy: op,
            cancelledAt: now,
          })
          .where(
            and(
              eq(ewohSchedulePlan.planId, planId),
              inArray(ewohSchedulePlan.status, [...cancellablePlanStatuses]),
            ),
          )
          .returning();
        if (planUpdated.length === 0) {
          throw new ConflictException('PLAN_CONCURRENT_CANCEL: 方案状态已变更，请刷新后重试');
        }

        await this.insertAudit(
          planId, 'cancel', op,
          `${reason}；回退 ${cancelled.length} 项、不可回退 ${irreversible.length} 项`,
          now, ctx.primaryOrgId,
        );

        return {
          cancelledAssignmentIds: cancelled.map((a) => a.assignmentId),
          irreversibleAssignmentIds: irreversible.map((a) => a.assignmentId),
          returnedTaskIds,
        };
      },
    );

    await this.auditService.appendAuditLog({
      actorId: op,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.cancel',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status },
      after: { status: 'cancelled', reason },
      reason,
      risk: true,
      metadata: {
        cancelledAssignmentIds: result.cancelledAssignmentIds.length,
        irreversibleAssignmentIds: result.irreversibleAssignmentIds.length,
      },
    });
    await this.outboxService.enqueue(
      'PlanCancelled',
      planId,
      {
        planId,
        reason,
        cancelledBy: op,
        cancelledAssignmentIds: result.cancelledAssignmentIds,
        irreversibleAssignmentIds: result.irreversibleAssignmentIds,
        returnedTaskIds: result.returnedTaskIds,
        occurredAt: now.toISOString(),
      },
      ctx.primaryOrgId || null,
      undefined,
      { planId, occurredAt: now.toISOString() },
    );
    const refreshed = await this.getPlan(planId, ctx);
    return {
      ...refreshed,
      cancel: {
        reason,
        cancelledBy: op,
        cancelledAt: now.toISOString(),
        cancelledAssignmentIds: result.cancelledAssignmentIds,
        irreversibleAssignmentIds: result.irreversibleAssignmentIds,
        returnedTaskIds: result.returnedTaskIds,
        releasedReservations: result.cancelledAssignmentIds.length,
      },
    } as SchedulingPlanV2;
  }

  /**
   * 下发方案：委托 DispatchCoordinator 原子下发（校验 → 预占 → 下发 → 审计 → 出站事件）。
   */
  async dispatchPlan(
    planId: string,
    ctx: OrgContext,
    wave?: { assignmentIds?: string[] },
  ): Promise<SchedulingPlanV2> {
    // NEST-026 修复（2026-08-17）：租户守卫先行——先 assertPlanTenantVisible
    // 再查 isShadow（旧顺序对跨租户 shadow 方案先抛 SHADOW_PLAN_GUARD，泄露
    // 「该 planId 存在且为 shadow」的存在性事实；跨租户一律 404 同语义）。
    const [planRow] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    // ADR-071：变面租户守卫（行缺失由 DispatchCoordinator 以 NotFound 处理）。
    assertPlanTenantVisible(planRow?.orgId, ctx, planId);
    // P4-SHADOW：Shadow Plan 服务端 hard guard——不可 dispatch（不靠前端隐藏按钮）。
    if (planRow?.isShadow) {
      throw new ConflictException('SHADOW_PLAN_GUARD: shadow plan cannot be dispatched');
    }
    // 未指定波次时保持既有调用形状（两参）——避免给既有契约加一个恒为
    // undefined 的第三参，也便于以调用形状为 oracle 的表征测试继续成立。
    const dispatchResult = wave
      ? await this.dispatchCoordinator.dispatch(planId, ctx, wave)
      : await this.dispatchCoordinator.dispatch(planId, ctx);
    const plan = await this.getPlan(planId, ctx);
    // 协调器未返回摘要时不编造 dispatch 事实（例如测试替身只验证"被调用"）。
    // 缺失就是缺失：宁可不给该字段，也不能写一个看似正常的默认摘要。
    if (!dispatchResult) return plan;
    // 分波次事实随方案一起回传（additive）：调用方必须能区分"整单派工完成"
    // 与"只派了一波"。仅看 plan.status 不足以判断后者（部分派工时计划保持
    // approved，以免把半成品方案标成契约终态）。
    return {
      ...plan,
      dispatch: {
        planStatus: dispatchResult.planStatus ?? plan.status,
        dispatchedAssignmentIds: dispatchResult.dispatchedAssignmentIds ?? [],
        remainingAssignmentIds: dispatchResult.remainingAssignmentIds ?? [],
        remainingAssignments: dispatchResult.remainingAssignments ?? 0,
        dispatchedAssignments: dispatchResult.dispatchedAssignments,
      },
    } as SchedulingPlanV2;
  }

  /**
   * P0-2 约束生命周期：加载指定方案仍生效（active=true 且未过期）的持久化约束，
   * 反序列化为 SchedulingConstraint，供查询与重排继承。
   * T02：读真实列 valid_from_ms/expires_at_ms/org_id/source/deactivated_at/deactivated_by，
   * 过期约束（expires_at_ms != null AND expires_at_ms < now）视为失效（不参与求解）。
   */
  async listPlanConstraints(
    planId: string,
    actor?: OrgContext,
  ): Promise<import('@shared/api.interface').SchedulingConstraint[]> {
    const conditions = [
      eq(ewohSchedulingConstraint.planId, planId),
      eq(ewohSchedulingConstraint.active, true),
      or(
        isNull(ewohSchedulingConstraint.expiresAtMs),
        gte(ewohSchedulingConstraint.expiresAtMs, Date.now()),
      ),
    ];
    // ADR-072：约束读面 org 条件（org 匹配或 NULL 存量；与 RLS 语义等价）。
    if (actor) {
      conditions.push(
        or(
          isNull(ewohSchedulingConstraint.orgId),
          eq(ewohSchedulingConstraint.orgId, actor.primaryOrgId),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(and(...conditions))
      .orderBy(asc(ewohSchedulingConstraint.createdAt));
    return rows.map((r) => {
      const v = (r.valueJson ?? {}) as Record<string, unknown>;
      return {
        id: r.constraintId,
        type: r.type as import('@shared/api.interface').SchedulingConstraint['type'],
        taskId: r.taskId ?? undefined,
        personId: v.personId as string | undefined,
        deviceId: v.deviceId as string | undefined,
        stationId: v.stationId as string | undefined,
        zoneId: v.zoneId as string | undefined,
        startMs: v.startMs as number | undefined,
        endMs: v.endMs as number | undefined,
        operator: v.operator as string | undefined,
        reason: v.reason as string | undefined,
        validFrom: (v.validFrom as number | undefined) ?? (r.validFromMs ?? undefined),
        expiresAt: (v.expiresAt as number | undefined) ?? (r.expiresAtMs ?? undefined),
        // T02：真实列（standalone_023）。
        validFromMs: r.validFromMs ?? null,
        expiresAtMs: r.expiresAtMs ?? null,
        orgId: r.orgId ?? null,
        source: (r.source ?? 'manual') as import('@shared/api.interface').SchedulingConstraint['source'],
        deactivatedAt: r.deactivatedAt ? r.deactivatedAt.toISOString() : null,
        deactivatedBy: r.deactivatedBy ?? null,
        snapshotVersion: v.snapshotVersion as string | undefined,
        // R2-SCH-010（2026-08-17）：按类型判定软约束（与 constraint-loader 同源），
        // 持久化软类型不再被一律标记为硬。
        hard: !isSoftConstraintType(r.type),
      } as import('@shared/api.interface').SchedulingConstraint;
    });
  }

  /**
   * P0-2 约束继承：重排时合并「当前方案仍生效的持久化人工约束」与「请求新约束」。
   *
   * 人工 LOCK/EXCLUDE/PREFER 等不得因为下一次普通 replan 传入 [] 而消失。
   * T02：统一委托 ConstraintLoaderService.loadForPlan（org + active + 有效期过滤统一入口）。
   */
  async loadEffectiveConstraints(
    planId: string,
    requestConstraints: import('@shared/api.interface').SchedulingConstraint[],
    ctx?: OrgContext,
  ): Promise<import('@shared/api.interface').SchedulingConstraint[]> {
    // NEST-027（2026-08-17）：ctx 缺失不再静默回退全租户 SYSTEM_CTX——显式 warn
    // 降级，且经 NEST-004 补齐后系统路径仅加载全局（NULL org）约束行（fail-closed）。
    const effectiveCtx =
      ctx ??
      (this.logger.warn(
        'loadEffectiveConstraints: actor ctx missing; falling back to global (NULL-org) constraints only',
      ),
      {
        userId: 'system',
        primaryOrgId: '',
        role: 'system' as const,
        accessibleOrgIds: [] as string[],
        isGlobalAdmin: false,
      });
    return this.constraintLoaderService.loadForPlan(
      planId,
      requestConstraints,
      effectiveCtx,
    );
  }

  /**
   * P0-2 解除人工约束：将约束标记为 inactive（软删除），并写审计。
   * 约束解除后下一次 replan 不再继承它。
   */
  async deactivateConstraint(
    constraintId: string,
    actor: OrgContext,
    reason = '',
  ): Promise<{ ok: boolean; constraintId: string }> {
    // NEST-028 修复（2026-08-17）：SELECT 与 UPDATE 均带 org 条件（org 匹配或
    // NULL 存量）——跨租户 constraintId 一律 404，不再被停用；UPDATE 返回行数
    // 校验兜底（0 行=行被并发删除/不可见 → 404）。
    const orgCond = actor.primaryOrgId
      ? or(
          isNull(ewohSchedulingConstraint.orgId),
          eq(ewohSchedulingConstraint.orgId, actor.primaryOrgId),
        )
      : undefined;
    const [row] = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(
        orgCond
          ? and(eq(ewohSchedulingConstraint.constraintId, constraintId), orgCond)
          : eq(ewohSchedulingConstraint.constraintId, constraintId),
      )
      .limit(1);
    if (!row) throw new NotFoundException(`Constraint ${constraintId} not found`);
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(actor),
      async () => {
        const updated = await this.db
          .update(ewohSchedulingConstraint)
          .set({ active: false, updatedAt: new Date() })
          .where(
            orgCond
              ? and(
                  eq(ewohSchedulingConstraint.constraintId, constraintId),
                  orgCond,
                )
              : eq(ewohSchedulingConstraint.constraintId, constraintId),
          )
          .returning({ id: ewohSchedulingConstraint.id });
        if (updated.length === 0) {
          throw new NotFoundException(
            `Constraint ${constraintId} not found (concurrent delete or invisible)`,
          );
        }
        await this.db.insert(ewohScheduleAudit).values({
          auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
          planId: row.planId ?? undefined,
          action: 'constraint.deactivate',
          operator: actor.userId,
          reason: reason || `deactivate constraint ${constraintId}`,
          createdAt: new Date(),
          // ADR-075：audit 行归属注入（001 ewoh_org_visible RLS 对齐）。
          orgId: actor.primaryOrgId || null,
        });
      },
    );
    await this.auditService.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action: 'scheduler.constraint.deactivate',
      entityType: 'scheduling_constraint',
      entityId: constraintId,
      before: { active: true },
      after: { active: false },
      reason: reason || undefined,
    });
    return { ok: true, constraintId };
  }

  /**
   * 重排：接受锁定约束，落库为 scheduling_constraint，
   * 基于最新快照重跑求解器，冻结 executing/locked 任务，产出新版方案。
   */
  async replan(
    planId: string,
    body: { lockedConstraints: SolverConstraint[]; operator?: string; reason?: string; targetPolicyVersion?: number },
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    // ADR-071：变面租户守卫（反枚举 404；与 RLS 语义等价）。
    assertPlanTenantVisible(plan.orgId, ctx, planId);

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const newVersion = (plan.version ?? 1) + 1;
    // P2（2026-08-19 审计）planId 嵌套增长：原 `${planId}-R${n}` 以父方案
    // 全串为前缀，逐代重排线性增长（PLAN-a → PLAN-a-R2 → PLAN-a-R2-R3…，
    // 落库列宽/日志/引用链全部膨胀）。改为剥离历代 -R 后缀后按根 ID 重编：
    // 第 n 代恒为 <root>-Rn（version 单调递增保证代际唯一）。
    const rootPlanId = planId.replace(/-R\d+$/, '');
    const newPlanId = `${rootPlanId}-R${newVersion}`;

    // 继承原方案的策略与时间窗；旧数据/缺失时回退生效策略或默认。
    let policy:
      | import('@shared/api.interface').SchedulingPolicy
      | undefined;
    let horizonMinutes = plan.horizonMinutes ?? 480;
    let policyChangeNote: string | undefined;

    if (body.targetPolicyVersion != null) {
      policy =
        (await this.schedulingPolicyService.getPolicy(
          body.targetPolicyVersion,
        )) ?? undefined;
      if (!policy) {
        this.logger.warn(
          `replan targetPolicyVersion ${body.targetPolicyVersion} not found; falling back to inherited/active policy`,
        );
      } else {
        horizonMinutes = (await this.schedulingPolicyService.getConfigByVersion(
          body.targetPolicyVersion,
        ))?.horizonMinutes ?? horizonMinutes;
        policyChangeNote = `replan 使用显式策略版本 v${body.targetPolicyVersion}`;
      }
    }

    if (!policy) {
      const inherited = plan.policyVersion != null
        ? await this.schedulingPolicyService.getPolicy(plan.policyVersion)
        : null;
      policy = inherited ?? (await this.schedulingPolicyService.getActivePolicy());
    }

    // P0-2 约束继承：合并「当前方案仍生效的持久化人工约束」与请求约束。
    // 人工 LOCK/EXCLUDE/PREFER 不得因为普通 replan 传入 [] 而消失。
    const effectiveConstraints = await this.loadEffectiveConstraints(
      planId,
      // NO-62c：可选字段缺省 → 空数组（"本次重排没有新增人工约束"），
      // 不是"约束丢失"；显式传非数组由 ConstraintLoader 400 拒绝。
      (body.lockedConstraints ?? []) as import('@shared/api.interface').SchedulingConstraint[],
      ctx,
    );

    // Phase 3 / P3-T4：安全关键任务禁止被重排改变分配/时间（硬校验）。
    await this.assertNoSafetyCriticalChange(planId, 'replan', effectiveConstraints, ctx);

    const newPlan = await this.solverService.solve(snapshot, effectiveConstraints, {
      planId: newPlanId,
      planName: `${plan.planName ?? planId} 重排`,
      triggerType: 'MANUAL',
      triggerEntityId: planId,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes,
      policy,
    });
    newPlan.version = newVersion;

    // T02 / P0-2：计划约束快照（确定性 replay + 审计）——落库求解所用 constraints + 稳定哈希。
    newPlan.constraints = effectiveConstraints;
    newPlan.effectiveConstraintsHash =
      this.constraintLoaderService.hashConstraints(effectiveConstraints);

    // R2-SCH-014（2026-08-17）：persistPlan 与约束落库/supersede 同事务——
    // 此前 persistPlan 独立事务先行提交，第二事务（约束+supersede+审计）失败时
    // 留下半状态（新方案已落库但旧方案未 superseded/约束丢失）。
    // RequestDatabaseContext 嵌套复用同一事务（与 NEST-125/129 同模式）。
    try {
      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          await this.persistPlan(newPlan, ctx);

          // P0-2：落库本次新增的有效约束（含请求约束；继承的约束已在原 plan 下，
          // 保持原 constraintId 以便后续解除与审计追溯——此处仅落库新请求项）。
          // NEST-029 修复（2026-08-17）：过滤继承项——effectiveConstraints 混含
          // 原方案已落库的继承约束（其 c.id 已存在于原 plan 下），全部重插会
          // 撞 constraint_id 唯一键（org 复合键下同 org 同 id）或产生重复行；
          // 仅落库本次请求新增项（无 id 的请求约束）。继承约束经 planId 继承
          // 机制继续生效（loadForPlan），无需复制到新 plan。
          const newConstraints = effectiveConstraints.filter(
            (c) => c.id == null,
          );
          if (newConstraints.length > 0) {
            await this.db.insert(ewohSchedulingConstraint).values(
              newConstraints.map((c, i) => ({
                constraintId:
                  c.id ?? `CON-${Date.now()}-${i}-${this.randomSuffix()}`,
                planId: newPlanId,
                taskId: c.taskId ?? null,
                type: c.type,
                valueJson: {
                  personId: c.personId ?? null,
                  deviceId: c.deviceId ?? null,
                  stationId: c.stationId ?? null,
                  zoneId: c.zoneId ?? null,
                  startMs: c.startMs ?? null,
                  endMs: c.endMs ?? null,
                  operator: c.operator ?? ctx.userId,
                  reason: c.reason ?? null,
                  validFrom: c.validFrom ?? null,
                  expiresAt: c.expiresAt ?? null,
                  snapshotVersion: c.snapshotVersion ?? snapshot.snapshotVersion,
                  // VALDR-01（V366）：数值型参数此前不在名册里，落库即丢、下一次重排取不回阈值。
                  value: c.value ?? null,
                },
                active: true,
                createdBy: ctx.userId,
                // standalone_025_scheduler_rls：租户隔离（null=全局/存量行，policy 放行）。
                orgId: ctx.primaryOrgId || null,
              })),
            );
          }

          // 旧方案标记为 superseded
          await this.db
            .update(ewohSchedulePlan)
            .set({ status: 'superseded', supersededBy: newPlanId })
            .where(eq(ewohSchedulePlan.planId, planId));

          await this.insertAudit(
            planId,
            'replan',
            body.operator || ctx.userId,
            [body.reason ?? '', policyChangeNote ?? ''].filter(Boolean).join('; '),
            new Date(),
            ctx.primaryOrgId,
          );
        },
      );
    } catch (error) {
      // 并发 replan 竞态：两个 replan 基于同一 plan.version 计算同一 newPlanId，
      // 输家在 ewoh_schedule_plan.plan_id 唯一键（23505）上冲突。这是确定性
      // 竞态结局而非内部错误——按模块内既有约定（resource-reservation P0-5
      // 「DB 约束是硬后盾，原生错误统一转 409 避免 500」）转 ConflictException。
      if (isPlanIdUniqueViolation(error)) {
        throw new ConflictException(
          'PLAN_REPLAN_CONFLICT: plan is being replaced by a concurrent replan',
        );
      }
      throw error;
    }

    await this.auditService.appendAuditLog({
      actorId: body.operator || ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.replan',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status, version: plan.version },
      after: { status: 'superseded', supersededBy: newPlanId },
      reason: policyChangeNote
        ? [body.reason ?? '', policyChangeNote].filter(Boolean).join('; ')
        : body.reason,
    });
    return newPlan;
  }

  /** 对比两个方案的分配与指标差异。NEST-030：读取透传 actor（租户校验）。 */
  async comparePlans(
    planId: string,
    otherPlanId: string,
    actor?: OrgContext,
  ): Promise<Record<string, unknown>> {
    // NEST-030 修复（2026-08-17）：两个方案读取都经 ADR-071 getPlan 守卫
    // （此前 getPlan 不传 actor，跨租户方案可被对比）。
    const [a, b] = await Promise.all([
      this.getPlan(planId, actor),
      this.getPlan(otherPlanId, actor),
    ]);
    const diffByTask = new Map<string, Record<string, unknown>>();
    const aByTask = new Map(a.assignments.map((x) => [x.taskId, x]));
    const bByTask = new Map(b.assignments.map((x) => [x.taskId, x]));

    for (const taskId of new Set([...aByTask.keys(), ...bByTask.keys()])) {
      const x = aByTask.get(taskId);
      const y = bByTask.get(taskId);
      const same =
        x?.personId === y?.personId &&
        x?.deviceId === y?.deviceId &&
        x?.plannedStart === y?.plannedStart;
      diffByTask.set(taskId, {
        personChanged: x?.personId !== y?.personId,
        deviceChanged: x?.deviceId !== y?.deviceId,
        timeChanged: x?.plannedStart !== y?.plannedStart,
        same,
      });
    }

    return {
      planA: a.planId,
      planB: b.planId,
      metricsA: a.metrics,
      metricsB: b.metrics,
      metricsDelta: {
        lateMinutes: b.metrics.lateMinutes - a.metrics.lateMinutes,
        walkingMeters: b.metrics.walkingMeters - a.metrics.walkingMeters,
        stationWaitMinutes:
          b.metrics.stationWaitMinutes - a.metrics.stationWaitMinutes,
        maxWorkload: b.metrics.maxWorkload - a.metrics.maxWorkload,
        changeCost: b.metrics.changeCost - a.metrics.changeCost,
      },
      assignmentDelta: Array.from(diffByTask.values()),
    };
  }

  private async insertAudit(
    planId: string,
    action: string,
    operator: string,
    reason: string,
    createdAt: Date,
    orgId?: string | null,
  ): Promise<void> {
    await this.db.insert(ewohScheduleAudit).values({
      auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
      planId,
      action,
      operator,
      reason,
      createdAt,
      // ADR-075：audit 行归属注入（001 ewoh_org_visible RLS 对齐；null=legacy）。
      orgId: orgId ?? null,
    });
  }

  private async toPlanV2(
    plan: typeof ewohSchedulePlan.$inferSelect,
    assignmentRows: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>,
    slim = false,
  ): Promise<SchedulingPlanV2> {
    const metrics = (plan.metricsJson ?? {}) as Partial<SchedulingPlanV2['metrics']>;
    const assignments: SchedulingAssignment[] = assignmentRows.map((a) => {
      const explanation = (a.explanationJson ?? {}) as {
        reasons?: string[];
        alternatives?: Array<Record<string, unknown>>;
      };
      // slim（列表）模式：剥离重量级字段（decisionTrace ~36KB/assignment、
      // alternatives、scoreBreakdown），与 createRun 响应瘦身同款——列表页
      // 不需要这些明细，按需 GET /plans/:planId 获取完整数据。
      if (slim) {
        return {
          assignmentId: a.assignmentId,
          taskId: a.taskId ?? '',
          personId: a.personId ?? null,
          deviceId: a.deviceId ?? null,
          stationId: a.stationId ?? null,
          zoneId: a.zoneId ?? null,
          plannedStart: a.plannedStart ? a.plannedStart.toISOString() : null,
          plannedEnd: a.plannedEnd ? a.plannedEnd.toISOString() : null,
          routeId: a.routeId ?? null,
          status: (a.status ?? 'proposed') as SchedulingAssignment['status'],
          reasons: explanation.reasons ?? [],
          // 契约必填字段：列表模式不返回明细，置空数组（不返回 36KB alternatives）。
          alternatives: [],
          etaSeconds: a.etaSeconds ?? undefined,
          distanceMeters: a.distanceMeters ?? undefined,
          riskLevel: a.riskLevel ?? undefined,
        };
      }
      return {
        assignmentId: a.assignmentId,
        taskId: a.taskId ?? '',
        personId: a.personId ?? null,
        deviceId: a.deviceId ?? null,
        stationId: a.stationId ?? null,
        zoneId: a.zoneId ?? null,
        plannedStart: a.plannedStart ? a.plannedStart.toISOString() : null,
        plannedEnd: a.plannedEnd ? a.plannedEnd.toISOString() : null,
        routeId: a.routeId ?? null,
        status: (a.status ?? 'proposed') as SchedulingAssignment['status'],
        reasons: explanation.reasons ?? [],
        alternatives: explanation.alternatives ?? [],
        etaSeconds: a.etaSeconds ?? undefined,
        distanceMeters: a.distanceMeters ?? undefined,
        riskLevel: a.riskLevel ?? undefined,
        scoreBreakdown: (a.scoreBreakdownJson ?? undefined) as SchedulingAssignment['scoreBreakdown'],
        decisionTrace: (a.decisionTraceJson ?? undefined) as SchedulingAssignment['decisionTrace'],
      };
    });

    return {
      planId: plan.planId,
      planName: plan.planName ?? undefined,
      // ADR-071：读模型组织归属透出（NULL=standalone_025 存量/全局过渡行）。
      orgId: plan.orgId ?? undefined,
      // B5 审批独立性（standalone_069）：生成操作者透出（NULL=存量/legacy 行），
      // 前端据此预判"自批"并给出明确说明（而非点击后 403）。
      createdBy: plan.createdBy ?? undefined,
      version: plan.version ?? 1,
      status: (plan.status ?? 'shadow') as PlanStatus,
      trigger: {
        type: plan.triggerType ?? 'MANUAL',
        entityId: plan.triggerEntityId ?? null,
      },
      snapshotVersion: plan.snapshotVersion ?? '',
      policyVersion: plan.policyVersion ?? 1,
      solverVersion: plan.solverVersion ?? 'heuristic-v2',
      // standalone_030_solver_activation（Task A / P0）：回读实际求解器状态/回退原因。
      solverStatus: (plan.solverStatus ?? undefined) as SchedulingPlanV2['solverStatus'],
      fallbackReason: plan.fallbackReason ?? undefined,
      horizonMinutes: plan.horizonMinutes ?? 480,
      assignments,
      metrics: {
        lateMinutes: metrics.lateMinutes ?? 0,
        walkingMeters: metrics.walkingMeters ?? 0,
        stationWaitMinutes: metrics.stationWaitMinutes ?? 0,
        maxWorkload: metrics.maxWorkload ?? 0,
        changeCost: metrics.changeCost ?? 0,
      },
      scoreBreakdown: slim
        ? undefined
        : (plan.scoreBreakdownJson ?? undefined) as SchedulingPlanV2['scoreBreakdown'],
      weights: slim
        ? undefined
        : (plan.weightsJson ?? undefined) as SchedulingPlanV2['weights'],
      // T02 / P0-2：计划约束快照（确定性 replay + 审计）。
      constraints: slim
        ? undefined
        : (plan.constraintsJson ?? []) as SchedulingPlanV2['constraints'],
      effectiveConstraintsHash: plan.effectiveConstraintsHash ?? null,
      baselineDelta: (plan.baselineDeltaJson ?? {}) as Record<string, unknown>,
      violations: slim
        ? undefined
        : (plan.violationsJson ?? []) as Array<Record<string, unknown>>,
      // AI 调度说明层（2026-08-21）：透传 LLM/规则模板生成的自然语言说明。
      aiNarration: plan.aiNarration ?? null,
      narrationSource:
        (plan.narrationSource as SchedulingPlanV2['narrationSource']) ?? null,
      // NO-12y / ADR-048：决策记录读回（契约形态；NULL=存量未投影行）。
      decisionRecords: slim
        ? undefined
        : (plan.decisionRecordsJson ?? undefined) as SchedulingPlanV2['decisionRecords'],
      createdAt: plan.createdAt ? plan.createdAt.toISOString() : new Date().toISOString(),
    };
  }

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  /**
   * Phase 3 / P3-T4：安全关键任务硬校验。
   * - replan：若入站约束会改变 safetyCritical 任务的分配（person/device/station）或时间窗，
   *   且与当前方案分配不一致 → 拒绝 SAFETY_CRITICAL_LOCKED（含原因字段）。
   * - approve：若方案会改变当前执行/锁定（snapshot.lockedAssignments）的 safetyCritical
   *   任务分配 → 拒绝 SAFETY_CRITICAL_LOCKED。
   * 快照无 safetyCritical 任务或操作不改变分配/时间时通过（不阻断正常重排/审批）。
   */
  private async assertNoSafetyCriticalChange(
    planId: string,
    operation: 'approve' | 'replan',
    constraints: import('@shared/api.interface').SchedulingConstraint[],
    ctx: OrgContext,
  ): Promise<void> {
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const safetyCriticalTasks = new Set(
      tasks.filter((t) => t.safetyCritical === true).map((t) => t.id),
    );
    if (safetyCriticalTasks.size === 0) return;

    const plan = await this.getPlan(planId);
    const currentByTask = new Map(
      plan.assignments.map((a) => [a.taskId, a]),
    );
    const nowMs = (t?: string | null): number | null => {
      const ms = t ? Date.parse(t) : NaN;
      return Number.isFinite(ms) ? ms : null;
    };

    if (operation === 'replan') {
      for (const c of constraints) {
        if (!c.taskId || !safetyCriticalTasks.has(c.taskId)) continue;
        const cur = currentByTask.get(c.taskId);
        if (!cur) continue;
        const changed =
          (c.personId != null && c.personId !== cur.personId) ||
          (c.deviceId != null && c.deviceId !== cur.deviceId) ||
          (c.stationId != null && c.stationId !== cur.stationId) ||
          (c.startMs != null && c.startMs !== nowMs(cur.plannedStart)) ||
          (c.endMs != null && c.endMs !== nowMs(cur.plannedEnd));
        if (changed) {
          throw new ConflictException(
            `SAFETY_CRITICAL_LOCKED: task ${c.taskId} 为安全关键任务，禁止通过重排改变其分配/时间`,
          );
        }
      }
      return;
    }

    // approve：方案不得改变执行/锁定中的 safetyCritical 任务分配。
    const lockedByTask = new Map(
      (snapshot.lockedAssignments ?? []).map((l) => [l.taskId, l]),
    );
    for (const tid of safetyCriticalTasks) {
      const locked = lockedByTask.get(tid);
      if (!locked) continue;
      const planned = currentByTask.get(tid);
      if (!planned) continue;
      const changed =
        (locked.personId != null && planned.personId !== locked.personId) ||
        (locked.deviceId != null && planned.deviceId !== locked.deviceId) ||
        (locked.stationId != null && planned.stationId !== locked.stationId);
      if (changed) {
        throw new ConflictException(
          `SAFETY_CRITICAL_LOCKED: task ${tid} 为安全关键任务，方案不得改变其执行/锁定分配`,
        );
      }
    }
  }

  /**
   * Replan V2（M03，08 §6）：自动重排 vs 人工审批政策判定（不抛错，返回明确结果）。
   * 命中任一维度 → HUMAN_APPROVAL_REQUIRED；未命中/未配置 replanApproval → AUTO_REPLAN。
   *
   * 判定维度：
   *  - critical_event（SAFETY_EVENT / ZONE_RESTRICTED 触发）
   *  - affectedRatio = affectedTaskIds / 可调度任务数 > autoMaxAffectedRatio（缺省 0.5）
   *  - 影响集合含 safetyCritical 任务（requireApprovalOnSafetyCritical 缺省 true）
   *  - 预期 churnRatio = churnDelta / affected > autoMaxChurnRatio（缺省 0.4）
   *  - 改派总数 changed+added+removed > maxChangedAssignments（缺省 20）
   *  - latenessDelta > 0 或 riskDelta > 0（预览保守原则）
   *  - 影响集合含人工 LOCK（snapshot.lockedAssignments；requireApprovalOnHumanLock 缺省 true）
   */
  async consultReplanApproval(input: {
    triggerType: string;
    impact: import('@shared/api.interface').ReplanImpact;
    preview?: import('@shared/api.interface').ReplanPreviewResult | null;
    ctx: OrgContext;
  }): Promise<import('@shared/api.interface').ReplanApprovalDecision> {
    const { triggerType, impact, preview, ctx } = input;
    // Unknown approval configuration is unknown risk. A DB/read failure must
    // surface to callers so they fail closed; only a real "no config" contract
    // preserves legacy AUTO_REPLAN behavior.
    const config = await this.schedulingPolicyService.resolveReplanApprovalConfig();
    if (!config) {
      return { decision: 'AUTO_REPLAN', reasons: [] };
    }
    const reasons: string[] = [];

    // 1) critical_event。
    if (triggerType === 'SAFETY_EVENT' || triggerType === 'ZONE_RESTRICTED') {
      reasons.push('critical_event');
    }

    const affectedSet = new Set(impact.affectedTaskIds ?? []);
    // P1（2026-08-19 审计）：审批政策判定只读 tasks/lockedAssignments——只读快照。
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(ctx);
    const schedulableCount = snapshot.tasks.filter((t) =>
      ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch', 'pending', 'queued'].includes(
        t.status,
      ),
    ).length;
    const affectedRatio =
      schedulableCount > 0 ? affectedSet.size / schedulableCount : 1;
    if (affectedRatio > (config.autoMaxAffectedRatio ?? 0.5)) {
      reasons.push('affected_ratio');
    }

    // 2) 含 safetyCritical 任务。
    if (config.requireApprovalOnSafetyCritical !== false) {
      const hasSafetyCritical = snapshot.tasks.some(
        (t) => t.safetyCritical === true && affectedSet.has(t.id),
      );
      if (hasSafetyCritical) reasons.push('safety_critical');
    }

    // 3) 含人工 LOCK。
    if (config.requireApprovalOnHumanLock !== false) {
      const hasHumanLock = (snapshot.lockedAssignments ?? []).some((l) =>
        affectedSet.has(l.taskId),
      );
      if (hasHumanLock) reasons.push('human_lock');
    }

    // 4) 预期 churn 比例 / lateness / risk 增量（需 preview）。
    if (preview) {
      const affectedCount = Math.max(preview.affectedTaskCount, 1);
      const churnRatio =
        preview.churnDelta / affectedCount;
      if (churnRatio > (config.autoMaxChurnRatio ?? 0.4)) {
        reasons.push('churn_ratio');
      }
      // 改派总数（changed+added+removed）超限 → 人工审批。
      const changedTotal =
        preview.changedAssignmentCount +
        preview.addedAssignmentCount +
        preview.removedAssignmentCount;
      if (changedTotal > (config.maxChangedAssignments ?? 20)) {
        reasons.push('max_changed_assignments');
      }
      if (preview.latenessDelta > 0 || preview.riskDelta > 0) {
        reasons.push('lateness_risk_delta');
      }
    }

    return {
      decision: reasons.length > 0 ? 'HUMAN_APPROVAL_REQUIRED' : 'AUTO_REPLAN',
      reasons,
    };
  }
}