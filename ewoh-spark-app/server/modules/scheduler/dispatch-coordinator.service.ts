import {
  Inject,
  Injectable,
  Logger,
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
  ewohSchedulingPlanAssignment,
  ewohProductionTask,
  ewohAssignmentEvent,
} from '@server/database/schema';
import { and, eq } from 'drizzle-orm';
import type { DispatchCoordinatorResult } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { ResourceReservationService, type ReservationInput } from './resource-reservation.service';
import { OutboxService } from './outbox.service';
import { TaskService } from '../task/task.service';
import { TaskLifecycle } from './task-lifecycle';
import { SchedulingFeedbackService } from './scheduling-feedback.service';

/** 事务化的执行闭环：校验 → 预占 → 下发 → 审计 → 出站事件。 */
@Injectable()
export class DispatchCoordinatorService {
  private readonly logger = new Logger(DispatchCoordinatorService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly reservationService: ResourceReservationService,
    private readonly outboxService: OutboxService,
    private readonly auditService: AuditService,
    private readonly taskService: TaskService,
    @Optional() private readonly feedbackService?: SchedulingFeedbackService,
  ) {}

  /**
   * 原子下发：所有 DB 写入在单个事务内完成，任一步失败整体回滚。
   * 步骤 2 的快照新鲜度校验在事务之前执行。
   */
  async dispatch(planId: string, ctx: OrgContext): Promise<DispatchCoordinatorResult> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    if (plan.status !== 'approved') {
      throw new ConflictException('PLAN_NOT_APPROVED');
    }

    // 快照新鲜度强校验（事务之前）。
    await this.worldStateSnapshotService.assertFreshForApprove(
      plan.snapshotVersion ?? '',
    );

    const outboxEventIds: string[] = [];
    const taskIds: string[] = [];
    let assignmentCount = 0;

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.planId, planId),
              eq(ewohSchedulingPlanAssignment.status, 'approved'),
            ),
          );
        assignmentCount = assignments.length;

        // 4. 预检任务可下发性（遵循 TaskService 状态机语义）。
        const taskByAssignmentId = new Map<
          string,
          typeof ewohProductionTask.$inferSelect
        >();
        for (const a of assignments) {
          if (!a.taskId) continue;
          const [task] = await this.db
            .select()
            .from(ewohProductionTask)
            .where(eq(ewohProductionTask.id, a.taskId))
            .limit(1);
          if (!task) {
            throw new NotFoundException(`Task ${a.taskId} not found`);
          }
          if (!TaskLifecycle.isDispatchable(task.status)) {
            throw new ConflictException('PLAN_TASK_NOT_DISPATCHABLE');
          }
          taskByAssignmentId.set(a.assignmentId, task);
        }

        // 5. CAS 更新方案状态（double-dispatch 守卫）。
        const updated = await this.db
          .update(ewohSchedulePlan)
          .set({ status: 'dispatched' })
          .where(
            and(
              eq(ewohSchedulePlan.planId, planId),
              eq(ewohSchedulePlan.status, 'approved'),
            ),
          )
          .returning();
        if (updated.length === 0) {
          throw new ConflictException('PLAN_CONCURRENT_DISPATCH');
        }

        // 6. 预占资源（person + device + station）。
        for (const a of assignments) {
          const startMs = a.plannedStart
            ? a.plannedStart.getTime()
            : Date.now();
          const endMs = a.plannedEnd
            ? a.plannedEnd.getTime()
            : startMs + 3600_000;
          const inputs: ReservationInput[] = [];
          if (a.personId) {
            inputs.push({
              resourceType: 'person',
              resourceId: a.personId,
              startMs,
              endMs,
            });
          }
          if (a.deviceId) {
            inputs.push({
              resourceType: 'device',
              resourceId: a.deviceId,
              startMs,
              endMs,
            });
          }
          if (a.stationId) {
            inputs.push({
              resourceType: 'station',
              resourceId: a.stationId,
              startMs,
              endMs,
            });
          }
          if (inputs.length > 0) {
            await this.reservationService.reserve(
              planId,
              a.assignmentId,
              a.taskId ?? null,
              inputs,
              ctx,
            );
          }
        }

        // 7. 更新任务（assignee/device/version），pending_dispatch → dispatched。
        for (const a of assignments) {
          if (!a.taskId) continue;
          const task = taskByAssignmentId.get(a.assignmentId);
          if (!task) continue;
          await this.db
            .update(ewohProductionTask)
            .set({
              assigneeId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              version: (task.version ?? 1) + 1,
            })
            .where(eq(ewohProductionTask.id, a.taskId));

          if (task.status === 'pending_dispatch') {
            await this.taskService.transitionTaskState(a.taskId, 'dispatch', ctx);
          }
        }

        // 8. 更新分配状态。
        for (const a of assignments) {
          await this.db
            .update(ewohSchedulingPlanAssignment)
            .set({ status: 'dispatched' })
            .where(eq(ewohSchedulingPlanAssignment.assignmentId, a.assignmentId));
        }

        // 9. 写入分配事件。
        for (const a of assignments) {
          await this.db.insert(ewohAssignmentEvent).values({
            eventId: `EVT-${Date.now()}-${this.randomSuffix()}`,
            assignmentId: a.assignmentId,
            taskId: a.taskId ?? null,
            personId: a.personId ?? null,
            deviceId: a.deviceId ?? null,
            fromStatus: 'approved',
            toStatus: 'dispatched',
            actor: ctx.userId,
            reason: 'plan dispatched',
          });
        }

        // 10. 审计。
        await this.auditService.appendAuditLog({
          actorId: ctx.userId,
          orgId: ctx.primaryOrgId,
          action: 'scheduler.plan.dispatch',
          entityType: 'schedule_plan',
          entityId: planId,
          before: { status: plan.status },
          after: { status: 'dispatched', assignments: assignments.length },
        });

        // 11. 出站事件。
        for (const a of assignments) {
          const evt = await this.outboxService.enqueue(
            'assignment.dispatched',
            a.assignmentId,
            {
              planId,
              taskId: a.taskId ?? null,
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
            },
            ctx.primaryOrgId,
          );
          outboxEventIds.push(evt.id);
          if (a.taskId) taskIds.push(a.taskId);
        }
        const planEvt = await this.outboxService.enqueue(
          'plan.dispatched',
          planId,
          { planId, assignments: assignments.length },
          ctx.primaryOrgId,
        );
        outboxEventIds.push(planEvt.id);
      },
    );

    // 观测型：记录 planned 基线反馈。失败不影响下发（仅记录日志）。
    if (this.feedbackService) {
      try {
        await this.feedbackService.recordBaseline(planId, undefined, ctx);
      } catch (err) {
        this.logger.warn(
          `scheduling feedback baseline skipped for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      planId,
      dispatchedAt: new Date().toISOString(),
      dispatchedAssignments: assignmentCount,
      reservedAssignments: assignmentCount,
      taskIds,
      outboxEventIds,
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