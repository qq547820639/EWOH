import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Optional,
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
import { eq, asc, and } from 'drizzle-orm';
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
    @Optional() private readonly feedbackService?: SchedulingFeedbackService,
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
   * 审批方案：校验 version + snapshotVersion，过期则抛 PLAN_STALE。
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

    if (plan.version !== body.version) {
      throw new ConflictException('PLAN_STALE');
    }
    await this.worldStateSnapshotService.assertFreshForApprove(
      body.snapshotVersion,
    );

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

  /** 观测型：记录审批验收反馈。失败仅记日志，不影响审批流程。 */
  private recordAcceptanceFeedback(
    planId: string,
    accepted: boolean,
    ctx: OrgContext,
  ): void {
    if (!this.feedbackService) return;
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
    await this.dispatchCoordinator.dispatch(planId, ctx);
    return this.getPlan(planId);
  }

  /**
   * P0-2 约束生命周期：加载指定方案仍生效（active=true）的持久化约束，
   * 反序列化为 SchedulingConstraint，供查询与重排继承。
   */
  async listPlanConstraints(
    planId: string,
  ): Promise<import('@shared/api.interface').SchedulingConstraint[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(
        and(eq(ewohSchedulingConstraint.planId, planId), eq(ewohSchedulingConstraint.active, true)),
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
        validFrom: v.validFrom as number | undefined,
        expiresAt: v.expiresAt as number | undefined,
        snapshotVersion: v.snapshotVersion as string | undefined,
        hard: true,
      } as import('@shared/api.interface').SchedulingConstraint;
    });
  }

  /**
   * P0-2 约束继承：重排时合并「当前方案仍生效的持久化人工约束」与「请求新约束」。
   *
   * 人工 LOCK/EXCLUDE/PREFER 等不得因为下一次普通 replan 传入 [] 而消失。
   */
  async loadEffectiveConstraints(
    planId: string,
    requestConstraints: import('@shared/api.interface').SchedulingConstraint[],
  ): Promise<import('@shared/api.interface').SchedulingConstraint[]> {
    const inherited = await this.listPlanConstraints(planId);
    // 请求约束优先（operator 来源显式标注）；同类型同目标时请求覆盖继承
    const merged = [...requestConstraints];
    for (const c of inherited) {
      const alreadyRequested = merged.some(
        (rc) => rc.type === c.type && rc.taskId === c.taskId && rc.personId === c.personId,
      );
      if (!alreadyRequested) merged.push(c);
    }
    return merged;
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
    );

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
}