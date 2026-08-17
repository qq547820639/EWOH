import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
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
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { DispatchCoordinatorResult } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { ResourceReservationService, type ReservationInput } from './resource-reservation.service';
import {
  projectDispatchDecision,
  projectResourceReservationDecision,
} from './decision-projection';
import { appendPlanDecisionRecords } from './decision-ledger';
import type { DecisionRecord } from '@shared/decision';
import { OutboxService } from './outbox.service';
import { TaskService } from '../task/task.service';
import { TaskLifecycle } from './task-lifecycle';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TravelCostService } from './travel-cost.service';

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
    // T02 / P0-1（G1）：观测基线反馈（必选；生产路径始终注入）。
    private readonly feedbackService: SchedulingFeedbackService,
    // P1-SCHED-004：统一默认任务时长来源（必选；Solver/Plan/Reservation/Dispatch 共享同一策略）。
    private readonly policyService: SchedulingPolicyService,
    // §5.4 ADVISORY 模式：safety-critical 降级路线阻断判定（必选；scheduler.module 已注册）。
    private readonly travelCostService: TravelCostService,
  ) {}

  /**
   * P1-SCHED-004：统一默认任务时长来源（SchedulingPolicyConfig.defaultTaskDurationMs）。
   * Solver / Plan / Reservation / Dispatch 共享同一值，禁止各层硬编码不同默认。
   */
  private async resolveDefaultDurationMs(): Promise<number> {
    try {
      const config = await this.policyService.getConfig();
      const configured = config?.defaultTaskDurationMs;
      if (typeof configured === 'number' && configured > 0) {
        return configured;
      }
    } catch (err) {
      this.logger.warn(
        `policy default duration unavailable, using 30min fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 1_800_000; // 与 SchedulingPolicyService 默认一致（30 分钟）
  }

  /**
   * 原子下发：所有 DB 写入在单个事务内完成，任一步失败整体回滚。
   * 步骤 2 的快照新鲜度校验在事务之前执行。
   */
  async dispatch(planId: string, ctx: OrgContext): Promise<DispatchCoordinatorResult> {
    // NEST-008 修复（2026-08-17）：dispatch 初始 SELECT 补 org 条件（org 匹配
    // 或 NULL 存量）——事务前无 GUC 的裸读此前仅靠 RLS 兜底且存在时序缺口；
    // 跨租户 planId 直接 404（与"不存在"同语义，反枚举）。
    const orgCond = ctx.primaryOrgId
      ? or(
          isNull(ewohSchedulePlan.orgId),
          eq(ewohSchedulePlan.orgId, ctx.primaryOrgId),
        )
      : undefined;
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(
        orgCond
          ? and(eq(ewohSchedulePlan.planId, planId), orgCond)
          : eq(ewohSchedulePlan.planId, planId),
      )
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    if (plan.status !== 'approved') {
      throw new ConflictException('PLAN_NOT_APPROVED');
    }

    // 快照新鲜度强校验（事务之前）。NEST-101：透传 ctx（同 org 时间切片比较）。
    await this.worldStateSnapshotService.assertFreshForApprove(
      plan.snapshotVersion ?? '',
      ctx,
    );

    // v0.7 Batch6.3 SAFETY_EVENT 派工熔断：方案基于最新世界状态时，
    // 若任何派工涉及被安全事件阻断（L2/L3 open）的人员/设备 → 拒绝下发。
    // 安全阻断不可被人工覆盖绕过（与求解器 SAFETY_BLOCK 硬约束同源语义）。
    // P0-7：同时从当前世界状态读取工位容量（station.capacity），供预占容量感知。
    // NEST-101：世界状态读取透传 ctx（org 过滤）。
    const currentWorld = await this.worldStateSnapshotService.getCurrentWorldState(ctx);
    // NEST-009（2026-08-17）：本次 dispatch 的固定基准时间——缺失 plannedStart
    // 的 assignment 统一使用同一 nowMs（此前逐 assignment 取 Date.now()，
    // 重试/慢事务下预占时间窗漂移）。
    const dispatchNowMs = Date.now();
    const stationCapacityById = new Map<string, number>(
      (currentWorld.stations ?? []).map((s) => [s.id, s.capacity ?? 1]),
    );
    {
      const blockedPersons = new Set(currentWorld.safetyBlockedPersonIds ?? []);
      const blockedDevices = new Set(currentWorld.safetyBlockedDeviceIds ?? []);
      if (blockedPersons.size > 0 || blockedDevices.size > 0) {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.planId, planId),
              eq(ewohSchedulingPlanAssignment.status, 'approved'),
            ),
          );
        const blocked = assignments.filter(
          (a) =>
            (a.personId && blockedPersons.has(a.personId)) ||
            (a.deviceId && blockedDevices.has(a.deviceId)),
        );
        if (blocked.length > 0) {
          throw new ConflictException(
            `SAFETY_BLOCK_DISPATCH: ${blocked.length} assignment(s) reference safety-blocked resources`,
          );
        }
      }
    }

    // §5.4 ADVISORY 模式 fail-closed：euclidean 降级仅参考，safety-critical 任务
    // 不得自动 dispatch 降级路径（route graph 不可达 → 拒绝派工，非安全任务正常放行）。
    // 与 SAFETY_BLOCK 同级位于事务之外，fail-fast 且异常即整体失败（无部分提交）。
    {
      const config = await this.policyService.getConfig();
      if (config.routeCostMode === 'ADVISORY') {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.planId, planId),
              eq(ewohSchedulingPlanAssignment.status, 'approved'),
            ),
          );
        for (const a of assignments) {
          if (!a.taskId || !a.personId) continue;
          const [task] = await this.db
            .select({ safetyCritical: ewohProductionTask.safetyCritical })
            .from(ewohProductionTask)
            .where(eq(ewohProductionTask.id, a.taskId))
            .limit(1);
          if (!task || !task.safetyCritical) continue;
          const cost = await this.travelCostService.estimate(a.personId, a.taskId);
          if (cost.source === 'euclidean_fallback') {
            throw new ConflictException(
              `SAFETY_CRITICAL_DEGRADED_ROUTE: task=${a.taskId} has degraded route under ADVISORY mode`,
            );
          }
        }
      }
    }

    // P1-SCHED-004：统一默认时长（与 Solver/Policy 一致），仅在 assignment 缺失
    // plannedEnd 时作为兜底，避免 1h 硬编码与 solver 30min 不一致。
    const fallbackDurationMs = await this.resolveDefaultDurationMs();

    // P0-7：下发前 station 容量预检（fail-fast，与求解器/预占容量语义一致）。
    {
      const assignments = await this.db
        .select()
        .from(ewohSchedulingPlanAssignment)
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.planId, planId),
            eq(ewohSchedulingPlanAssignment.status, 'approved'),
          ),
        );
      const stationInputs: ReservationInput[] = [];
      for (const a of assignments) {
        if (!a.stationId) continue;
        const startMs = a.plannedStart ? a.plannedStart.getTime() : dispatchNowMs;
        const endMs = a.plannedEnd
          ? a.plannedEnd.getTime()
          : startMs + fallbackDurationMs;
        stationInputs.push({
          resourceType: 'station',
          resourceId: a.stationId,
          startMs,
          endMs,
          capacity: stationCapacityById.get(a.stationId) ?? 1,
        });
      }
      if (stationInputs.length > 0) {
        await this.reservationService.assertStationCapacityAvailable(
          stationInputs,
          ctx,
        );
      }
    }

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

        // R2-SSV-14（2026-08-17）：事务内复查安全阻断事实——安全阻断集合与
        // 快照新鲜度此前均在事务前读取（TOCTOU：预检与提交之间发生
        // SAFETY_EVENT/快照过期时派工仍会提交，SAFETY_BLOCK_DISPATCH 被绕过）。
        // 事务内以最新世界状态复查关键事实，安全熔断与提交同一串行化域。
        {
          const txWorld =
            await this.worldStateSnapshotService.getCurrentWorldState(ctx);
          const txBlockedPersons = new Set(txWorld.safetyBlockedPersonIds ?? []);
          const txBlockedDevices = new Set(txWorld.safetyBlockedDeviceIds ?? []);
          if (txBlockedPersons.size > 0 || txBlockedDevices.size > 0) {
            const blockedTx = assignments.filter(
              (a) =>
                (a.personId && txBlockedPersons.has(a.personId)) ||
                (a.deviceId && txBlockedDevices.has(a.deviceId)),
            );
            if (blockedTx.length > 0) {
              throw new ConflictException(
                `SAFETY_BLOCK_DISPATCH_TX: ${blockedTx.length} assignment(s) reference safety-blocked resources (in-transaction recheck)`,
              );
            }
          }
          await this.worldStateSnapshotService.assertFreshForApprove(
            plan.snapshotVersion ?? '',
            ctx,
          );
        }

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
        // NO-13k / ADR-060：收集真实预占结果（台账事实），事务末统一
        // 追加 resource_reservation 决策记录（§12 Decision History）。
        const reservationDecisions: Array<{
          assignment: typeof ewohSchedulingPlanAssignment.$inferSelect;
          results: Awaited<ReturnType<ResourceReservationService['reserve']>>;
        }> = [];
        for (const a of assignments) {
          const startMs = a.plannedStart
            ? a.plannedStart.getTime()
            : dispatchNowMs;
          const endMs = a.plannedEnd
            ? a.plannedEnd.getTime()
            : startMs + fallbackDurationMs;
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
              // P0-7：容量感知预占（station 允许多个重叠任务，count < capacity）。
              capacity: stationCapacityById.get(a.stationId) ?? 1,
            });
          }
          if (inputs.length > 0) {
            const results = await this.reservationService.reserve(
              planId,
              a.assignmentId,
              a.taskId ?? null,
              inputs,
              ctx,
            );
            reservationDecisions.push({ assignment: a, results });
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
            // NEST-047（2026-08-17）：Date.now()+短随机后缀 → randomUUID。
            eventId: `EVT-${randomUUID()}`,
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

        // 12. NO-13k/NO-13l（ADR-060/061）：预占（kind #4）+ 派工（kind #5）
        // 决策记录单次读-追加-回写进方案决策台账（与派工同事务原子；
        // 投影缺口/追加失败 log 显式绝不阻断派工主流程，§2/§33）。
        try {
          const projected = this.projectReservationDecisionRecords(
            planId,
            reservationDecisions,
            ctx,
          );
          const dispatchProjection = projectDispatchDecision({
            planId,
            assignmentRiskLevels: assignments.map((a) => a.riskLevel ?? null),
            dispatchCount: assignmentCount,
            outboxEventIds,
            orgId: ctx.primaryOrgId ?? '',
            operator: ctx.userId ?? null,
            now: new Date(),
          });
          const issues = [...projected.issues];
          if (dispatchProjection.record) {
            projected.records.push(dispatchProjection.record);
          }
          issues.push(...dispatchProjection.issues);
          if (issues.length > 0) {
            this.logger.warn(
              `派工决策投影缺口（显式跳过，§33）：${issues.join(',')}`,
            );
          }
          await this.appendDecisionRecords(planId, projected.records, ctx.primaryOrgId || null);
        } catch (err) {
          this.logger.warn(
            `派工决策台账追加失败（不阻断派工主流程）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    // 观测型：记录 planned 基线反馈。失败不影响下发（仅记录日志）。
    try {
      await this.feedbackService.recordBaseline(planId, undefined, ctx);
    } catch (err) {
      this.logger.warn(
        `scheduling feedback baseline skipped for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  /**
   * NO-13k / ADR-060：预占结果 → resource_reservation 决策记录（契约门内；
   * 缺口显式计数，§33 绝不静默丢弃/伪造）。
   */
  private projectReservationDecisionRecords(
    planId: string,
    entries: Array<{
      assignment: typeof ewohSchedulingPlanAssignment.$inferSelect;
      results: Awaited<ReturnType<ResourceReservationService['reserve']>>;
    }>,
    ctx: OrgContext,
  ): { records: DecisionRecord[]; issues: string[] } {
    const records: DecisionRecord[] = [];
    const issues: string[] = [];
    const now = new Date();
    for (const entry of entries) {
      for (const reservation of entry.results) {
        const projected = projectResourceReservationDecision({
          planId,
          assignmentId: entry.assignment.assignmentId,
          taskId: entry.assignment.taskId ?? null,
          reservation,
          assignmentRiskLevel: entry.assignment.riskLevel ?? null,
          orgId: ctx.primaryOrgId ?? '',
          operator: ctx.userId ?? null,
          now,
        });
        if (projected.record) {
          records.push(projected.record);
        }
        for (const reason of projected.issues) {
          issues.push(`${entry.assignment.assignmentId}:${reason}`);
        }
      }
    }
    return { records, issues };
  }

  /**
   * NO-13k/NO-13l（ADR-060/061）：决策记录追加 decision_records_json
   * （ADR-062 决策 2 §31 单一实现；与派工同事务原子；无 CAS——本事务内
   * double-dispatch 已由 PLAN_CONCURRENT_DISPATCH 守卫）。
   */
  private async appendDecisionRecords(
    planId: string,
    records: DecisionRecord[],
    orgId?: string | null,
  ): Promise<void> {
    // NEST-024：决策台账追加携带 org 条件（跨租户 planId 不再被追加）。
    await appendPlanDecisionRecords(this.db, planId, records, orgId ?? null);
  }
}