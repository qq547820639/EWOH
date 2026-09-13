import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohAssignmentEvent, ewohDevice, ewohProductionTask, ewohSchedulePlan, ewohSchedulingExecution, ewohSchedulingFeedback, ewohSchedulingPlanAssignment } from '@server/database/schema';
import type { ExecutionUpdateRequest, RecordActualsRequest } from '@shared/api.interface';
import type { ExecutionReceiptResult, ExecutionReceiptSummary, ExecutionReceiptRequest, FeedbackActualsReceiptRequest } from '@shared/execution-receipt';
import type { OrgContext } from '../shared/org-context.interceptor';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { TaskService, taskActionPath } from '../task/task.service';
import { ExecutionService } from './execution.service';
import { receiptProvenance, hasIndependentApproval, independentReceiptEvidence } from './execution-receipt-provenance';

/** Both public endpoints converge here. All domain writes and outbox share one GUC transaction. */
@Injectable()
export class ExecutionReceiptApplicationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly executionService: ExecutionService,
    private readonly taskService: TaskService,
  ) {}

  async applyFromExecutionUpdate(assignmentId: string, body: ExecutionReceiptRequest, actor?: OrgContext): Promise<ExecutionReceiptResult> {
    const result = await this.apply({ assignmentId }, body, actor);
    if (!result) throw new NotFoundException('RECEIPT_ASSIGNMENT_NOT_FOUND');
    return result;
  }

  async applyFromActuals(input: FeedbackActualsReceiptRequest, actor?: OrgContext): Promise<ExecutionReceiptResult | null> {
    return this.apply(input, {
      actualStartAt: input.actualStart ?? undefined,
      actualEndAt: input.actualEnd ?? undefined,
      // Feedback travel is seconds; execution travel is milliseconds. Wait is milliseconds in both.
      actualTravelMs: input.actualTravel == null ? undefined : input.actualTravel * 1000,
      actualWaitingMs: input.actualWait ?? undefined,
      reportedSource: input.reportedSource,
    }, actor, true);
  }

  private async apply(keys: RecordActualsRequest, body: ExecutionReceiptRequest, actor?: OrgContext, allowUnmatched = false): Promise<ExecutionReceiptResult | null> {
    if (body.note != null && body.deviationReason != null && body.note !== body.deviationReason) throw new BadRequestException('RECEIPT_NOTE_CONFLICT');
    body = { ...body, deviationReason: body.deviationReason ?? body.note };
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId || !actor?.userId) throw new ForbiddenException('RECEIPT_ACTOR_AND_ORG_REQUIRED');
    if (!keys.assignmentId && !keys.planId && !keys.taskId) throw new BadRequestException('RECEIPT_MATCH_KEY_REQUIRED');
    if (body.reportedSource != null && !['manual_report', 'simulated'].includes(body.reportedSource)) throw new BadRequestException('INVALID_REPORTED_SOURCE');
    const ctx = actor;
    return this.requestDatabaseContext.runInTransaction(buildGucSettings(ctx), async () => {
      // Resolve keys with AND, never OR: do not let one task/plan broaden an assignment receipt.
      const candidates = await this.db.select().from(ewohSchedulingPlanAssignment).where(and(
        eq(ewohSchedulingPlanAssignment.orgId, orgId),
        keys.assignmentId ? eq(ewohSchedulingPlanAssignment.assignmentId, keys.assignmentId) : undefined,
        keys.planId ? eq(ewohSchedulingPlanAssignment.planId, keys.planId) : undefined,
        keys.taskId ? eq(ewohSchedulingPlanAssignment.taskId, keys.taskId) : undefined,
      )).limit(2);
      if (!candidates.length) {
        if (allowUnmatched) return null;
        throw new NotFoundException('RECEIPT_ASSIGNMENT_NOT_FOUND');
      }
      if (candidates.length !== 1) throw new ConflictException('AMBIGUOUS_RECEIPT: provide assignmentId');
      const candidate = candidates[0];
      if (!candidate.taskId) throw new ConflictException('RECEIPT_TASK_REQUIRED');
      // Take row locks before reading mutable state. Plan -> task -> assignment is the lock order.
      const [plan] = await this.db.select().from(ewohSchedulePlan).where(and(
        eq(ewohSchedulePlan.planId, candidate.planId), eq(ewohSchedulePlan.orgId, orgId),
      )).for('share');
      const [task] = await this.db.select().from(ewohProductionTask).where(and(
        eq(ewohProductionTask.id, candidate.taskId), eq(ewohProductionTask.orgId, orgId),
      )).for('update');
      const [assignment] = await this.db.select().from(ewohSchedulingPlanAssignment).where(and(
        eq(ewohSchedulingPlanAssignment.id, candidate.id), eq(ewohSchedulingPlanAssignment.orgId, orgId),
      )).for('update');
      if (!task || !assignment || assignment.taskId !== task.id || assignment.planId !== candidate.planId) throw new ConflictException('RECEIPT_LINK_CHANGED');
      const roles = new Set([...(ctx.roles ?? []), ...(ctx.role ? [ctx.role] : [])]);
      const privileged = ctx.isGlobalAdmin || ['global_admin', 'dispatcher', 'device_ops', 'workshop_lead'].some(role => roles.has(role));
      // 2026-09-10 修复：这里原先比较 `assignment.personId !== ctx.userId`——两个
      // 不同的标识空间（人员域 vs 登录账号域），因此 worker 角色**永远**无法回执
      // 自己的任务，只能借用特权角色，现场闭环对真正的现场人员是断的。
      // 现在比较账号↔人员绑定（ewoh_user.person_id → JWT → ctx.personId）。
      // 未绑定时 fail-closed（与修复前同样拒绝，不放宽）：宁可让工人找班组长绑定，
      // 也不能让任何人凭 id 巧合回执他人任务。
      const boundPerson = ctx.personId?.trim() || null;
      if (!privileged && (!boundPerson || assignment.personId !== boundPerson)) {
        throw new ForbiddenException('ACTUALS_ADVANCEMENT_FORBIDDEN');
      }
      if (!plan || !hasIndependentApproval(plan) || plan.isShadow || !['approved', 'dispatched', 'executing', 'completed'].includes(plan.status ?? '')) throw new ConflictException('RECEIPT_PLAN_NOT_AUTHORIZED');
      if (!['dispatched', 'executing', 'completed', 'failed', 'cancelled'].includes(assignment.status)) throw new ConflictException('RECEIPT_ASSIGNMENT_NOT_DISPATCHED');
      let [row] = await this.db.select().from(ewohSchedulingExecution).where(and(
        eq(ewohSchedulingExecution.assignmentId, assignment.assignmentId), eq(ewohSchedulingExecution.orgId, orgId),
      )).for('update');
      // Repair a dispatch whose post-dispatch execution initialization previously failed.
      if (!row) {
        await this.executionService.createFromPlan(plan, [{
          ...assignment, taskId: task.id,
          plannedStart: assignment.plannedStart?.toISOString() ?? null,
          plannedEnd: assignment.plannedEnd?.toISOString() ?? null,
          etaSeconds: assignment.etaSeconds ?? undefined,
          distanceMeters: assignment.distanceMeters ?? undefined,
        }], orgId, ctx);
        [row] = await this.db.select().from(ewohSchedulingExecution).where(and(
          eq(ewohSchedulingExecution.assignmentId, assignment.assignmentId), eq(ewohSchedulingExecution.orgId, orgId),
        )).for('update');
      }
      if (!row || row.planId !== plan.planId || row.taskId !== task.id) throw new ConflictException('RECEIPT_EXECUTION_LINK_MISMATCH');
      const target = body.status ?? (body.actualEndAt != null ? 'COMPLETED' : body.actualStartAt != null ? 'STARTED' : row.status);
      const desiredAssignment = ({ PLANNED: 'dispatched', DISPATCHED: 'dispatched', STARTED: 'executing', PAUSED: 'executing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' } as Record<string, string>)[target];
      const desiredTask = ({ STARTED: 'executing', PAUSED: 'paused', COMPLETED: 'completed', FAILED: 'exception', CANCELLED: 'cancelled' } as Record<string, string>)[target];
      if (!desiredAssignment) throw new BadRequestException('INVALID_EXECUTION_STATUS');
      if (['completed', 'failed', 'cancelled'].includes(assignment.status) && assignment.status !== desiredAssignment) throw new ConflictException('ASSIGNMENT_ALREADY_TERMINAL');
      if (assignment.status === 'executing' && desiredAssignment === 'dispatched') throw new ConflictException('ASSIGNMENT_STATE_REGRESSION');
      let actions: string[] = [];
      if (desiredTask && task.status !== desiredTask) {
        if (!['dispatched', 'received', 'executing', 'paused'].includes(task.status)) throw new ConflictException('TASK_STATE_REQUIRES_EXPLICIT_RESOLUTION');
        actions = desiredTask === 'cancelled' ? ['cancel'] : taskActionPath(task.status, desiredTask) ?? [];
        if (!actions.length || actions.includes('resolve')) throw new ConflictException('ILLEGAL_RECEIPT_TASK_TRANSITION');
      }
      if (keys.actualResource) {
        for (const key of ['personId', 'deviceId', 'stationId'] as const) {
          if (keys.actualResource[key] != null && keys.actualResource[key] !== assignment[key]) throw new ConflictException('RECEIPT_RESOURCE_MISMATCH: reassign through dispatch first');
        }
      }
      // Same plan/assignment advisory key as baseline initialization prevents concurrent duplicate baselines.
      await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${plan.planId} || '|' || ${assignment.assignmentId}))`);
      const feedbackRows = await this.db.select().from(ewohSchedulingFeedback).where(and(
        eq(ewohSchedulingFeedback.orgId, orgId), eq(ewohSchedulingFeedback.planId, plan.planId), eq(ewohSchedulingFeedback.assignmentId, assignment.assignmentId),
      )).for('update');
      if (feedbackRows.length > 1) throw new ConflictException('DUPLICATE_FEEDBACK_REQUIRES_RECONCILIATION');
      const feedback = feedbackRows[0];
      if (feedback && feedback.taskId !== task.id) throw new ConflictException('RECEIPT_FEEDBACK_LINK_MISMATCH');
      for (const [field, executionField] of [['actualStart', 'actualStartAt'], ['actualEnd', 'actualEndAt']] as const) {
        const incoming = body[executionField] ?? row[executionField]?.toISOString();
        if (feedback?.[field] && !incoming) throw new ConflictException('RECEIPT_MISSING_EXECUTION_FACT_REQUIRES_RECONCILIATION');
        if (feedback?.[field] && incoming && feedback[field].getTime() !== new Date(incoming).getTime()) throw new ConflictException('RECEIPT_FEEDBACK_FACT_CONFLICT');
      }
      const execution = await this.executionService.update(assignment.assignmentId, { ...body, status: target as ExecutionUpdateRequest['status'] }, orgId);
      const summary: ExecutionReceiptSummary = { matchedRows: 1, advancedAssignments: 0, advancedTaskSteps: 0, skips: [] };
      if (assignment.status !== desiredAssignment) {
        const changed = await this.db.update(ewohSchedulingPlanAssignment).set({ status: desiredAssignment, version: sql`${ewohSchedulingPlanAssignment.version} + 1` }).where(and(
          eq(ewohSchedulingPlanAssignment.id, assignment.id), eq(ewohSchedulingPlanAssignment.orgId, orgId), eq(ewohSchedulingPlanAssignment.status, assignment.status),
        )).returning();
        if (!changed.length) throw new ConflictException('ASSIGNMENT_STATE_CONFLICT');
        await this.db.insert(ewohAssignmentEvent).values({ eventId: `EVT-${randomUUID()}`, orgId, assignmentId: assignment.assignmentId, taskId: task.id, actor: ctx.userId, fromStatus: assignment.status, toStatus: desiredAssignment, reason: 'canonical execution receipt' });
        summary.advancedAssignments++;
      }
      for (const action of actions) {
        await this.taskService.transitionTaskState(task.id, action, ctx);
        summary.advancedTaskSteps++;
      }
      const [device] = assignment.deviceId ? await this.db.select().from(ewohDevice).where(and(eq(ewohDevice.id, assignment.deviceId), eq(ewohDevice.orgId, orgId))).limit(1) : [];
      const provenance = receiptProvenance({
        orgId,
        plan,
        task,
        device,
        persistedExecution: row,
        execution: {
          orgId: execution.orgId,
          planId: execution.planId,
          taskId: execution.taskId,
          assignmentId: execution.assignmentId,
          executionId: execution.executionId,
          deviceId: execution.deviceId,
          source: row.source,
          status: execution.status,
          actualStartAt: execution.actualStartAt,
          actualEndAt: execution.actualEndAt,
          snapshotVersion: execution.snapshotVersion,
        },
        prior: feedback?.provenanceJson,
        reportedSource: body.reportedSource,
      });
      // Preserve independent device facts only when they existed before this request.
      // Every HTTP-created actual is permanently manual/simulated, including omitted source.
      const persistedSource = provenance.source === 'simulated' ? 'simulated'
        : independentReceiptEvidence(row, execution) && provenance.source === 'real' ? row.source : 'manual_report';
      if (row.source !== persistedSource) await this.db.update(ewohSchedulingExecution).set({ source: persistedSource }).where(and(
        eq(ewohSchedulingExecution.id, row.id), eq(ewohSchedulingExecution.orgId, orgId),
      ));
      const values = {
        actualStart: execution.actualStartAt ? new Date(execution.actualStartAt) : null,
        actualEnd: execution.actualEndAt ? new Date(execution.actualEndAt) : null,
        actualTravel: execution.actualTravelMs == null ? null : execution.actualTravelMs / 1000,
        actualWait: execution.actualWaitingMs,
        actualResourceJson: { personId: assignment.personId, deviceId: assignment.deviceId, stationId: assignment.stationId },
        receiptSource: provenance.source, productionTrainingEligible: provenance.productionTrainingEligible, provenanceJson: provenance,
      };
      if (feedback) {
        const changed = Object.entries(values).some(([key, value]) => !isDeepStrictEqual(feedback[key as keyof typeof feedback], value));
        if (changed) await this.db.update(ewohSchedulingFeedback).set(values).where(and(eq(ewohSchedulingFeedback.id, feedback.id), eq(ewohSchedulingFeedback.orgId, orgId)));
      } else {
        await this.db.insert(ewohSchedulingFeedback).values({
          ...values, feedbackId: `FB-${randomUUID()}`, orgId, planId: plan.planId, assignmentId: assignment.assignmentId, taskId: task.id,
          runId: execution.runId, plannedStart: assignment.plannedStart, plannedEnd: assignment.plannedEnd, plannedTravel: assignment.etaSeconds,
          accepted: true, originalResourceJson: values.actualResourceJson,
        });
      }
      return { ...execution, receipt: { ...summary, ...provenance } };
    });
  }
}
