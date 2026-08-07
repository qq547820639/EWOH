import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
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
  ewohAssignmentEvent,
} from '@server/database/schema';
import { eq, asc } from 'drizzle-orm';
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
    return this.getPlan(planId);
  }

  /** 拒绝方案。 */
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

  /** 下发方案：分配 approved → dispatched，写入分配事件。 */
  async dispatchPlan(
    planId: string,
    ctx: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);

    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(eq(ewohSchedulingPlanAssignment.planId, planId));

    const now = new Date();
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulePlan)
          .set({ status: 'dispatched' })
          .where(eq(ewohSchedulePlan.planId, planId));

        for (const a of assignments) {
          await this.db
            .update(ewohSchedulingPlanAssignment)
            .set({ status: 'dispatched' })
            .where(eq(ewohSchedulingPlanAssignment.assignmentId, a.assignmentId));

          await this.db.insert(ewohAssignmentEvent).values({
            eventId: `EVT-${now.getTime()}-${a.assignmentId}`,
            assignmentId: a.assignmentId,
            taskId: a.taskId ?? null,
            personId: a.personId ?? null,
            deviceId: a.deviceId ?? null,
            fromStatus: a.status,
            toStatus: 'dispatched',
            actor: ctx.userId,
            reason: 'plan dispatched',
            createdAt: now,
          });
        }

        await this.insertAudit(planId, 'dispatch', ctx.userId, '', now);
      },
    );

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.dispatch',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status },
      after: { status: 'dispatched', assignments: assignments.length },
    });
    return this.getPlan(planId);
  }

  /**
   * 重排：接受锁定约束，落库为 scheduling_constraint，
   * 基于最新快照重跑求解器，冻结 executing/locked 任务，产出新版方案。
   */
  async replan(
    planId: string,
    body: { lockedConstraints: SolverConstraint[]; operator?: string; reason?: string },
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

    const newPlan = await this.solverService.solve(snapshot, body.lockedConstraints, {
      planId: newPlanId,
      planName: `${plan.planName ?? planId} 重排`,
      triggerType: 'MANUAL',
      triggerEntityId: planId,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: {
        latenessWeight: 1,
        walkingWeight: 1,
        workloadBalanceWeight: 1,
        stationWaitWeight: 1,
        changeCostWeight: 1,
      },
    });
    newPlan.version = newVersion;

    await this.persistPlan(newPlan, ctx);

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        // 落库锁定约束
        if (body.lockedConstraints.length > 0) {
          await this.db.insert(ewohSchedulingConstraint).values(
            body.lockedConstraints.map((c, i) => ({
              constraintId: `CON-${Date.now()}-${i}`,
              planId: newPlanId,
              taskId: c.taskId ?? null,
              type: c.type ?? 'LOCKED_PERSON',
              valueJson: {
                personId: c.personId,
                deviceId: c.deviceId,
                stationId: c.stationId,
                zoneId: c.zoneId,
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
          body.reason ?? '',
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
      reason: body.reason,
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
      horizonMinutes: 480,
      assignments,
      metrics: {
        lateMinutes: metrics.lateMinutes ?? 0,
        walkingMeters: metrics.walkingMeters ?? 0,
        stationWaitMinutes: metrics.stationWaitMinutes ?? 0,
        maxWorkload: metrics.maxWorkload ?? 0,
        changeCost: metrics.changeCost ?? 0,
      },
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