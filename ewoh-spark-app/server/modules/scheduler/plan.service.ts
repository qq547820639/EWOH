import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
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
} from '@server/database/schema';
import { eq, asc, and, inArray, desc, isNull, or, gte } from 'drizzle-orm';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  PlanStatus,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { SolverService, type SolverConstraint } from './solver.service';
import { WorldStateSnapshotService } from './world-state.service';
import { DispatchCoordinatorService } from './dispatch-coordinator.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { OutboxService } from './outbox.service';

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
  ) {}

  /** 持久化一个 V2 方案（ewoh_schedule_plan + 分配明细）。 */
  async persistPlan(
    plan: SchedulingPlanV2,
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
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
          horizonMinutes: plan.horizonMinutes ?? null,
          scoreBreakdownJson: (plan.scoreBreakdown ?? null) as unknown as Record<string, unknown> | null,
          // Phase 2 / P2-T2：实际投放的 8 权重快照（确定性 replay）。
          weightsJson: plan.weights ?? null,
          // T02 / P0-2：求解所用 effective constraints 快照 + 稳定哈希（standalone_023）。
          constraintsJson: (plan.constraints ?? []) as unknown as Record<string, unknown>[],
          effectiveConstraintsHash: plan.effectiveConstraintsHash ?? null,
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

  /** 读取完整方案（含分配明细）。 */
  async getPlan(planId: string): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);

    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(eq(ewohSchedulingPlanAssignment.planId, planId))
      .orderBy(asc(ewohSchedulingPlanAssignment.taskId));

    return this.toPlanV2(plan, assignments);
  }

  /**
   * M03：列出当前生效方案（active 状态 shadow/proposed/approved/dispatched/executing），
   * 按创建时间倒序。供 ReplanPreviewService 基线对比（预览只读，不落库）。
   */
  async listActivePlans(): Promise<SchedulingPlanV2[]> {
    const activeStatuses = [
      'draft',
      'shadow',
      'proposed',
      'approved',
      'dispatched',
      'executing',
    ];
    const rows = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(inArray(ewohSchedulePlan.status, activeStatuses))
      .orderBy(desc(ewohSchedulePlan.createdAt));
    const plans: SchedulingPlanV2[] = [];
    for (const row of rows) {
      try {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(eq(ewohSchedulingPlanAssignment.planId, row.planId))
          .orderBy(asc(ewohSchedulingPlanAssignment.taskId));
        plans.push(await this.toPlanV2(row, assignments));
      } catch (err) {
        this.logger.warn(
          `listActivePlans: skip ${row.planId}: ${err instanceof Error ? err.message : String(err)}`,
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

    // P4-SHADOW：Shadow Plan 服务端 hard guard——不可 approve（不靠前端隐藏按钮）。
    if (plan.isShadow) {
      throw new ConflictException('SHADOW_PLAN_GUARD: shadow plan cannot be approved');
    }

    if (plan.version !== body.version) {
      // T04 / P1-6：PLAN_STALE 事件化 + scoped replan（cause=PLAN_STALE）后仍拒绝审批。
      await this.notifyStalePlan(planId, ctx);
      throw new ConflictException('PLAN_STALE');
    }
    try {
      await this.worldStateSnapshotService.assertFreshForApprove(
        body.snapshotVersion,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'PLAN_STALE' || msg.includes('PLAN_STALE')) {
        await this.notifyStalePlan(planId, ctx);
      }
      throw err;
    }
    // Phase 3 / P3-T4：方案不得改变安全关键任务的锁定分配。
    await this.assertNoSafetyCriticalChange(planId, 'approve', [], ctx);

    const op = body.operator || ctx.userId;
    const now = new Date();
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulePlan)
          .set({
            status: 'approved',
            confirmedBy: op,
            confirmedAt: now,
            confirmReason: body.reason ?? '',
          })
          .where(eq(ewohSchedulePlan.planId, planId));

        await this.db
          .update(ewohSchedulingPlanAssignment)
          .set({ status: 'approved' })
          .where(eq(ewohSchedulingPlanAssignment.planId, planId));

        await this.insertAudit(planId, 'approve', op, body.reason ?? '', now);
      },
    );

    await this.auditService.appendAuditLog({
      actorId: op,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.approve',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status, version: plan.version },
      after: { status: 'approved' },
      reason: body.reason,
    });
    this.recordAcceptanceFeedback(planId, true, ctx);
    return this.getPlan(planId);
  }

  /**
   * T04 / P1-6：stale approve → outbox `stale_plan` 事件 + scoped replan（cause=PLAN_STALE）。
   * 观测型：失败仅记日志，不改变审批拒绝语义（PLAN_STALE 仍然抛异常）。
   */
  private async notifyStalePlan(
    planId: string,
    ctx: OrgContext,
  ): Promise<void> {
    try {
      await this.outboxService.enqueue(
        'stale_plan',
        planId,
        {
          planId,
          reason: 'approve rejected: PLAN_STALE',
          occurredAt: new Date().toISOString(),
        },
        ctx.primaryOrgId || null,
        undefined,
        {
          entityType: 'schedule_plan',
          planId,
          occurredAt: new Date().toISOString(),
        },
      );
      await this.replanCoordinator.handleTrigger('PLAN_STALE', planId, ctx);
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

    const op = body.operator || ctx.userId;
    const now = new Date();
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulePlan)
          .set({
            status: 'rejected',
            confirmedBy: op,
            confirmedAt: now,
            confirmReason: body.reason ?? '',
          })
          .where(eq(ewohSchedulePlan.planId, planId));

        await this.db
          .update(ewohSchedulingPlanAssignment)
          .set({ status: 'cancelled' })
          .where(eq(ewohSchedulingPlanAssignment.planId, planId));

        await this.insertAudit(planId, 'reject', op, body.reason ?? '', now);
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
    return this.getPlan(planId);
  }

  /**
   * 下发方案：委托 DispatchCoordinator 原子下发（校验 → 预占 → 下发 → 审计 → 出站事件）。
   */
  async dispatchPlan(
    planId: string,
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    // P4-SHADOW：Shadow Plan 服务端 hard guard——不可 dispatch（不靠前端隐藏按钮）。
    const [planRow] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (planRow?.isShadow) {
      throw new ConflictException('SHADOW_PLAN_GUARD: shadow plan cannot be dispatched');
    }
    await this.dispatchCoordinator.dispatch(planId, ctx);
    return this.getPlan(planId);
  }

  /**
   * P0-2 约束生命周期：加载指定方案仍生效（active=true 且未过期）的持久化约束，
   * 反序列化为 SchedulingConstraint，供查询与重排继承。
   * T02：读真实列 valid_from_ms/expires_at_ms/org_id/source/deactivated_at/deactivated_by，
   * 过期约束（expires_at_ms != null AND expires_at_ms < now）视为失效（不参与求解）。
   */
  async listPlanConstraints(
    planId: string,
  ): Promise<import('@shared/api.interface').SchedulingConstraint[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(
        and(
          eq(ewohSchedulingConstraint.planId, planId),
          eq(ewohSchedulingConstraint.active, true),
          or(
            isNull(ewohSchedulingConstraint.expiresAtMs),
            gte(ewohSchedulingConstraint.expiresAtMs, Date.now()),
          ),
        ),
      )
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
        hard: true,
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
    return this.constraintLoaderService.loadForPlan(
      planId,
      requestConstraints,
      ctx ?? { userId: 'system', primaryOrgId: '', role: 'system', accessibleOrgIds: [], isGlobalAdmin: false },
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
    const [row] = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(eq(ewohSchedulingConstraint.constraintId, constraintId))
      .limit(1);
    if (!row) throw new NotFoundException(`Constraint ${constraintId} not found`);
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(actor),
      async () => {
        await this.db
          .update(ewohSchedulingConstraint)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(ewohSchedulingConstraint.constraintId, constraintId));
        await this.db.insert(ewohScheduleAudit).values({
          auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
          planId: row.planId ?? undefined,
          action: 'constraint.deactivate',
          operator: actor.userId,
          reason: reason || `deactivate constraint ${constraintId}`,
          createdAt: new Date(),
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

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const newVersion = (plan.version ?? 1) + 1;
    const newPlanId = `${planId}-R${newVersion}`;

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
      body.lockedConstraints as import('@shared/api.interface').SchedulingConstraint[],
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

    await this.persistPlan(newPlan, ctx);

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        // P0-2：落库本次新增的有效约束（含请求约束；继承的约束已在原 plan 下，
        // 保持原 constraintId 以便后续解除与审计追溯——此处仅落库新请求项）。
        if (effectiveConstraints.length > 0) {
          await this.db.insert(ewohSchedulingConstraint).values(
            effectiveConstraints.map((c, i) => ({
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
              },
              active: true,
              createdBy: ctx.userId,
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
        );
      },
    );

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

  /** 对比两个方案的分配与指标差异。 */
  async comparePlans(
    planId: string,
    otherPlanId: string,
  ): Promise<Record<string, unknown>> {
    const [a, b] = await Promise.all([
      this.getPlan(planId),
      this.getPlan(otherPlanId),
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
  ): Promise<void> {
    await this.db.insert(ewohScheduleAudit).values({
      auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
      planId,
      action,
      operator,
      reason,
      createdAt,
    });
  }

  private async toPlanV2(
    plan: typeof ewohSchedulePlan.$inferSelect,
    assignmentRows: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>,
  ): Promise<SchedulingPlanV2> {
    const metrics = (plan.metricsJson ?? {}) as Partial<SchedulingPlanV2['metrics']>;
    const assignments: SchedulingAssignment[] = assignmentRows.map((a) => {
      const explanation = (a.explanationJson ?? {}) as {
        reasons?: string[];
        alternatives?: Array<Record<string, unknown>>;
      };
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
      version: plan.version ?? 1,
      status: (plan.status ?? 'shadow') as PlanStatus,
      trigger: {
        type: plan.triggerType ?? 'MANUAL',
        entityId: plan.triggerEntityId ?? null,
      },
      snapshotVersion: plan.snapshotVersion ?? '',
      policyVersion: plan.policyVersion ?? 1,
      solverVersion: plan.solverVersion ?? 'heuristic-v2',
      horizonMinutes: plan.horizonMinutes ?? 480,
      assignments,
      metrics: {
        lateMinutes: metrics.lateMinutes ?? 0,
        walkingMeters: metrics.walkingMeters ?? 0,
        stationWaitMinutes: metrics.stationWaitMinutes ?? 0,
        maxWorkload: metrics.maxWorkload ?? 0,
        changeCost: metrics.changeCost ?? 0,
      },
      scoreBreakdown: (plan.scoreBreakdownJson ?? undefined) as SchedulingPlanV2['scoreBreakdown'],
      weights: (plan.weightsJson ?? undefined) as SchedulingPlanV2['weights'],
      // T02 / P0-2：计划约束快照（确定性 replay + 审计）。
      constraints: (plan.constraintsJson ?? []) as SchedulingPlanV2['constraints'],
      effectiveConstraintsHash: plan.effectiveConstraintsHash ?? null,
      baselineDelta: (plan.baselineDeltaJson ?? {}) as Record<string, unknown>,
      violations: (plan.violationsJson ?? []) as Array<Record<string, unknown>>,
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
    const config = await this.schedulingPolicyService
      .resolveReplanApprovalConfig()
      .catch(() => null);
    if (!config) {
      return { decision: 'AUTO_REPLAN', reasons: [] };
    }
    const reasons: string[] = [];

    // 1) critical_event。
    if (triggerType === 'SAFETY_EVENT' || triggerType === 'ZONE_RESTRICTED') {
      reasons.push('critical_event');
    }

    const affectedSet = new Set(impact.affectedTaskIds ?? []);
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
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