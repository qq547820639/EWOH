import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { currentRequestContext } from '../../common/request-context';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulingFeedback,
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
  ewohProductionTask,
  ewohAssignmentEvent,
} from '@server/database/schema';
import { and, eq, inArray, or, isNull } from 'drizzle-orm';
import type {
  SchedulingFeedback,
  SchedulingFeedbackKpis,
  SchedulingFeedbackResource,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ShadowEvaluatorService } from './prediction/shadow-evaluator.service';
import { TaskService, taskActionPath } from '../task/task.service';

/**
 * 调度反馈（SchedulingFeedback，Task 7）+ 执行反馈完成腿（NO-13a / ADR-050）。
 *
 * 观测型记录 planned-vs-actual 执行数据与调度 KPI；NO-13a 起，recordActuals
 * 在回填真实执行事实（actualStart/actualEnd）后追加**状态推进**：
 *  - assignment：dispatched→executing（start）/ {dispatched,executing}→completed（end），
 *    CAS + ewohAssignmentEvent 事件（ADR-050 决策 1）；
 *  - task：taskActionPath 最短合法链逐动作 transitionTaskState（task.yaml 锁步，
 *    ADR-049），边界显式（ADR-050 决策 2）——exception 不隐式 resolve、
 *    pending_dispatch 不收 start、终态 no-op、非法 skip+log。
 * 推进失败只显式 log，绝不阻断反馈写入、绝不伪造状态（§33）；策略/评分/
 * 派工规则不受本服务影响。
 *
 * 生命周期埋点（由调用方在既有钩子处触发）：
 *  - recordBaseline   —— dispatch 时记录 planned 基线（每 assignment 一行）；
 *  - recordAcceptance —— plan 审批 / 驳回时标记 accepted；
 *  - recordActuals    —— 任务实际开始 / 完成时回填 actual 数据 + 状态推进。
 */
@Injectable()
export class SchedulingFeedbackService {
  private readonly logger = new Logger(SchedulingFeedbackService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    // M05：Prediction Shadow Learning 回填点（可选注入；缺失时静默跳过，不改变反馈写入）。
    private readonly shadowEvaluatorService?: ShadowEvaluatorService,
    // NO-13a / ADR-050：执行反馈完成腿（可选注入——既有构造兼容；缺失时只回填不推进）。
    private readonly taskService?: TaskService,
  ) {}

  /**
   * 在 dispatch 时记录 planned 基线（观测型，不改变任何调度行为）。
   * 每个 assignment 写入一行；无 assignment 时写一行 plan 级反馈。
   * @returns 写入/更新的反馈行数。
   */
  async recordBaseline(
    planId: string,
    opts?: {
      runId?: string | null;
      solverRuntime?: number | null;
      solverFallback?: boolean;
      replanCount?: number;
      conflictCount?: number;
      overrideCount?: number;
      ts?: Date;
    },
    ctx?: OrgContext,
  ): Promise<number> {
    // R2-SSV-15（2026-08-17）：plan/assignments 读取叠加 org 条件（本 org +
    // NULL 存量）——跨租户 planId 不再进入基线写入（此前会用他租户方案的
    // assignments 生成本租户反馈行，污染 KPI 面）。
    const orgId = ctx?.primaryOrgId ?? null;
    const planOrgCond = orgId
      ? and(
          eq(ewohSchedulePlan.planId, planId),
          or(
            isNull(ewohSchedulePlan.orgId),
            eq(ewohSchedulePlan.orgId, orgId),
          ),
        )
      : eq(ewohSchedulePlan.planId, planId);
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(planOrgCond)
      .limit(1);
    if (!plan) return 0;

    const assignmentOrgCond = orgId
      ? and(
          eq(ewohSchedulingPlanAssignment.planId, planId),
          or(
            isNull(ewohSchedulingPlanAssignment.orgId),
            eq(ewohSchedulingPlanAssignment.orgId, orgId),
          ),
        )
      : eq(ewohSchedulingPlanAssignment.planId, planId);
    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(assignmentOrgCond);

    const metrics = (plan.metricsJson ?? {}) as Record<string, unknown>;
    const solverRuntimeOpt = opts?.solverRuntime ?? (metrics['solveDurationMs'] as number | undefined) ?? null;
    const solverFallbackOpt =
      opts?.solverFallback ?? this.isFallbackStatus(metrics['solverStatus'] as string | undefined);
    const replanCount = opts?.replanCount ?? 0;
    const conflictCount = opts?.conflictCount ?? 0;
    const overrideCount = opts?.overrideCount ?? 0;
    const ts = opts?.ts ?? new Date();
    const runId = opts?.runId ?? plan.triggerEntityId ?? null;
    // 审批发生在 dispatch 之前，故此处按 plan 状态推导验收结果（approved→true, rejected→false）。
    const acceptedFromPlan =
      plan.status === 'approved' ? true : plan.status === 'rejected' ? false : null;

    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: orgId ?? '' },
    );

    // Phase 4 / P4-T1：plannedWait 语义——同 person 的连续任务，wait = start - 前一任务 end
    // （clamp ≥0）；无前任务（该人员首任务）→ 0（调度起点无等待，非伪造）。按 plannedStart 升序计算。
    const personSeq = new Map<string, { endMs: number }>();
    const sortedAssignments = [...assignments].sort((x, y) => {
      const xs = x.plannedStart ? x.plannedStart.getTime() : 0;
      const ys = y.plannedStart ? y.plannedStart.getTime() : 0;
      return xs - ys;
    });
    const waitByAssignment = new Map<string, number>();
    for (const a of sortedAssignments) {
      if (!a.assignmentId || !a.plannedStart || !a.personId) continue;
      const startMs = a.plannedStart.getTime();
      const prev = personSeq.get(a.personId);
      const waitMs = prev ? Math.max(startMs - prev.endMs, 0) : 0;
      waitByAssignment.set(a.assignmentId, waitMs);
      if (a.plannedEnd) personSeq.set(a.personId, { endMs: a.plannedEnd.getTime() });
    }

    let written = 0;
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const targets = assignments.length > 0 ? assignments : [null];

      // P2（2026-08-19 审计）advisory lock N+1：原循环内对每个 assignment
      // 单独 execute 一次 pg_advisory_xact_lock（N 次往返）。xact 级锁在
      // 事务结束前持续持有，循环前单语句批量预取全部锁与逐条获取的串行化
      // 语义完全等价（同一锁集覆盖整个事务），往返从 N 次降为 1 次。
      // NEST-127 原语义保持：键=plan|assignment；无 execute 能力的测试替身
      // 跳过锁（单进程测试无并发）。
      const lockAssignmentIds = [
        ...new Set(
          targets
            .map((a) => a?.assignmentId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (lockAssignmentIds.length > 0) {
        try {
          const lockCalls = lockAssignmentIds.map(
            (id) =>
              sql`pg_advisory_xact_lock(hashtext(${planId} || '|' || ${id}))`,
          );
          await this.db.execute(
            sql`SELECT ${sql.join(lockCalls, sql`, `)}`,
          );
        } catch {
          // 测试替身/无 execute 环境：跳过锁（单进程测试无并发）
        }
      }

      for (const a of targets) {
        const assignmentId = a?.assignmentId ?? null;
        const taskId = a?.taskId ?? null;
        const originalResource: SchedulingFeedbackResource | null = assignmentId
          ? {
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              stationId: a.stationId ?? null,
            }
          : null;

        const plannedStart = a?.plannedStart ?? null;
        const plannedEnd = a?.plannedEnd ?? null;
        // Phase 4 / P4-T1 语义修复：plannedTravel 记录 ETA 时间语义（etaSeconds），
        // 而非 distanceMeters；plannedWait 按同 person 前一任务 end 计算（不再恒 null）。
        const plannedTravel = a?.etaSeconds ?? null;
        const plannedWait = assignmentId ? waitByAssignment.get(assignmentId) ?? null : null;

        // 幂等：同一 assignment 已存在则回填 planned 基线，否则新增。
        const [existing] = assignmentId
          ? await this.db
              .select()
              .from(ewohSchedulingFeedback)
              .where(
                and(
                  eq(ewohSchedulingFeedback.assignmentId, assignmentId),
                  eq(ewohSchedulingFeedback.planId, planId),
                ),
              )
              .limit(1)
          : [];

        if (existing) {
          await this.db
            .update(ewohSchedulingFeedback)
            .set({
              plannedStart,
              plannedEnd,
              plannedTravel,
              plannedWait,
              originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
              replanCount,
              conflictCount,
              overrideCount,
              solverRuntime: solverRuntimeOpt,
              solverFallback: solverFallbackOpt,
              ts,
            })
            .where(eq(ewohSchedulingFeedback.feedbackId, existing.feedbackId));
        } else {
          await this.db.insert(ewohSchedulingFeedback).values({
            // R2-SSV-20：Date.now()+4 字符随机后缀（同毫秒 1/1.7M 碰撞）→ randomUUID。
            feedbackId: `FB-${randomUUID()}`,
            runId,
            planId,
            taskId,
            assignmentId,
            plannedStart,
            plannedEnd,
            plannedTravel,
            plannedWait,
            originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
            replanCount,
            conflictCount,
            overrideCount,
            solverRuntime: solverRuntimeOpt,
            solverFallback: solverFallbackOpt,
            accepted: acceptedFromPlan,
            ts,
            orgId,
          });
        }
        written += 1;
      }
    });

    this.logger.log(
      `scheduling feedback baseline recorded for plan ${planId} (${written} row${written === 1 ? '' : 's'})`,
    );
    return written;
  }

  /** 记录 plan 审批结果（accepted）。观测型，不影响审批流程。NEST-117：org 条件。 */
  async recordAcceptance(planId: string, accepted: boolean, ctx?: OrgContext): Promise<void> {
    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: '' },
    );
    const orgId = ctx?.primaryOrgId || null;
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      // NEST-117 修复（2026-08-17）：UPDATE 按 org 过滤（无 ctx 时不再跨租户
      // 改他租户 feedback 行的 accepted 标记；org 匹配或 NULL 存量）。
      await this.db
        .update(ewohSchedulingFeedback)
        .set({ accepted })
        .where(
          and(
            eq(ewohSchedulingFeedback.planId, planId),
            orgId
              ? or(
                  isNull(ewohSchedulingFeedback.orgId),
                  eq(ewohSchedulingFeedback.orgId, orgId),
                )
              : undefined,
          ),
        );
    });
    this.logger.log(
      `scheduling feedback acceptance=${String(accepted)} recorded for plan ${planId}`,
    );
  }

  /**
   * 回填任务实际执行数据（实际开始/结束、实际 travel/wait、实际资源）。
   * 观测型，不改变任务或调度状态。
   */
  async recordActuals(
    input: {
      planId?: string;
      assignmentId?: string;
      taskId?: string;
      actualStart?: Date | string | null;
      actualEnd?: Date | string | null;
      actualTravel?: number | null;
      actualWait?: number | null;
      actualResource?: SchedulingFeedbackResource | null;
    },
    ctx?: OrgContext,
  ): Promise<{
    advancedAssignments: number;
    advancedTaskSteps: number;
    skips: string[];
  }> {
    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: '' },
    );
    const toDate = (v: Date | string | null | undefined): Date | null =>
      v == null || v === '' ? null : new Date(v);

    const summary = {
      advancedAssignments: 0,
      advancedTaskSteps: 0,
      skips: [] as string[],
      // NEST-121（2026-08-17）：UPDATE ... RETURNING 真实命中行数（matched 事实）。
      matchedRows: 0,
    };

    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const conditions: any[] = [];
      if (input.assignmentId) {
        conditions.push(eq(ewohSchedulingFeedback.assignmentId, input.assignmentId));
      }
      if (input.planId) {
        conditions.push(eq(ewohSchedulingFeedback.planId, input.planId));
      }
      if (input.taskId) {
        conditions.push(eq(ewohSchedulingFeedback.taskId, input.taskId));
      }
      // NEST-160 修复（2026-08-17）：回填 UPDATE 按 org 过滤（ctx 携带 org 时
      // 仅本 org 行 + NULL 存量；此前任意 planId/taskId 可跨租户改反馈行）。
      if (ctx?.primaryOrgId) {
        conditions.push(
          or(
            isNull(ewohSchedulingFeedback.orgId),
            eq(ewohSchedulingFeedback.orgId, ctx.primaryOrgId),
          ),
        );
      }
      if (conditions.length === 0) return;

      const patch: Record<string, unknown> = {
        actualStart: toDate(input.actualStart),
        actualEnd: toDate(input.actualEnd),
      };
      if (input.actualTravel != null) patch.actualTravel = input.actualTravel;
      if (input.actualWait != null) patch.actualWait = input.actualWait;
      if (input.actualResource != null) {
        patch.actualResourceJson = input.actualResource as unknown as Record<string, unknown>;
      }

      // NEST-121：RETURNING 统计命中行数（matched 事实，供响应 matched 字段）。
      const updatedRows = await this.db
        .update(ewohSchedulingFeedback)
        .set(patch)
        .where(and(...conditions))
        .returning({ id: ewohSchedulingFeedback.id });
      summary.matchedRows = updatedRows.length;

      // NO-13a / ADR-050：执行反馈完成腿——真实执行事实推进 assignment/task 状态
      //（CAS + 事件 + 契约状态机最短合法链；失败只 log 不阻断反馈写入，§33）。
      await this.applyExecutionAdvancement(input, ctx ?? { userId: 'system', primaryOrgId: '' }, summary);

      // M05：Prediction Shadow Learning 回填——任务实际完成时回填 shadow 样本 actual。
      // 观测型：失败仅记日志，绝不阻断 feedback 写入；不改变任何生产调度。
      if (this.shadowEvaluatorService && input.actualEnd != null) {
        try {
          const actualMs =
            typeof input.actualEnd === 'string' || input.actualEnd instanceof Date
              ? new Date(input.actualEnd).getTime()
              : null;
          if (actualMs != null && Number.isFinite(actualMs)) {
            // 回填"任务时长"预测：actual = actualEnd − actualStart（有 start 时），
            // 否则用计划/实际 end 与 now 的差值不可靠 → 仅回填有 start 的样本。
            if (input.actualStart != null) {
              const startMs =
                typeof input.actualStart === 'string' || input.actualStart instanceof Date
                  ? new Date(input.actualStart).getTime()
                  : null;
              if (startMs != null && Number.isFinite(startMs)) {
                const durationActual = Math.max(0, actualMs - startMs);
                // 按 taskId 维度回填最近一条 task_duration 预测样本。
                const samples = this.shadowEvaluatorService.listSamples(ctx);
                for (const s of samples) {
                  if (
                    s.predictionType === 'task_duration' &&
                    (s as unknown as { taskId?: string }).taskId === input.taskId &&
                    s.actual == null
                  ) {
                    this.shadowEvaluatorService.backfillActual(
                      'task_duration',
                      durationActual,
                      s.createdAt,
                      ctx,
                    );
                    break;
                  }
                }
              }
            }
          }
        } catch (err) {
          this.logger.warn(
            `shadow sample backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
    return summary;
  }

  /**
   * NO-13a / ADR-050：执行事实 → assignment/task 状态推进（recordActuals 内联调用）。
   * 边界（ADR-050 决策 2）：start 源集 assignment={dispatched}、task={dispatched,received}；
   * end 源集 assignment={dispatched,executing}、task={executing,received,paused}；
   * exception 不隐式 resolve；终态/乱序 skip+log；CAS 幂等；推进失败不阻断反馈写入。
   */
  private async applyExecutionAdvancement(
    input: {
      planId?: string;
      assignmentId?: string;
      taskId?: string;
      actualStart?: Date | string | null;
      actualEnd?: Date | string | null;
    },
    ctx: OrgContext,
    summary: { advancedAssignments: number; advancedTaskSteps: number; skips: string[] },
  ): Promise<void> {
    const hasStart = input.actualStart != null && input.actualStart !== '';
    const hasEnd = input.actualEnd != null && input.actualEnd !== '';
    if (!hasStart && !hasEnd) return;

    // 1) 匹配受影响 assignment（与反馈行同源条件）。
    const assignmentConditions: any[] = [];
    if (input.assignmentId) {
      assignmentConditions.push(eq(ewohSchedulingPlanAssignment.assignmentId, input.assignmentId));
    }
    if (input.planId) {
      assignmentConditions.push(eq(ewohSchedulingPlanAssignment.planId, input.planId));
    }
    if (input.taskId) {
      assignmentConditions.push(eq(ewohSchedulingPlanAssignment.taskId, input.taskId));
    }
    if (assignmentConditions.length === 0) return;
    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(or(...assignmentConditions));

    // R2-SSV-13（2026-08-17）：状态推进写副作用按"受派者/可信角色"授权——
    // assignment/task 状态推进（含事件与 outbox 广播）远超观测回填，仅允许
    // 受派人本人（ctx.userId === assignment.personId）或可信调用方
    // （dispatcher / global_admin / device_ops / system）。非受派者对可推进
    // assignment 的回填整体 403 fail-closed（观测回填与推进同请求原子拒绝，
    // 杜绝同租户水平越权伪造 actualStart/actualEnd 推进他人任务）。
    if (!this.isTrustedAdvancementActor(ctx)) {
      const advancing = assignments.filter(
        (a) =>
          (hasStart && a.status === 'dispatched') ||
          (hasEnd && (a.status === 'executing' || a.status === 'dispatched')),
      );
      const unauthorized = advancing.filter(
        (a) => a.personId && a.personId !== ctx.userId,
      );
      if (unauthorized.length > 0) {
        throw new ForbiddenException(
          `ACTUALS_ADVANCEMENT_FORBIDDEN: ${
            unauthorized.length
          } assignment(s) not assigned to caller（R2-SSV-13：状态推进仅限受派人本人或 dispatcher/global_admin/device_ops）`,
        );
      }
    }

    const affectedTaskIds = new Set<string>();
    for (const a of assignments) {
      if (a.taskId) affectedTaskIds.add(a.taskId);
    }
    if (input.taskId) affectedTaskIds.add(input.taskId);

    // 2) assignment 推进（CAS + 事件；幂等：已一致/乱序 skip）。
    // R2-SSV-05（2026-08-17）：CAS UPDATE 校验 RETURNING 命中行数——仅命中>0
    // 才发事件并计数（此前并发反馈后到者 0 行命中仍无条件插事件，产生重复
    // assignment 事件与虚增 advancedAssignments）。
    for (const a of assignments) {
      const id = String(a.assignmentId ?? '');
      if (hasStart && a.status === 'dispatched') {
        const hit = await this.db
          .update(ewohSchedulingPlanAssignment)
          .set({ status: 'executing' })
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.assignmentId, id),
              eq(ewohSchedulingPlanAssignment.status, 'dispatched'),
            ),
          )
          .returning({ id: ewohSchedulingPlanAssignment.id });
        if (hit.length > 0) {
          await this.insertAssignmentEvent(id, a.taskId ?? null, 'dispatched', 'executing', ctx, 'execution feedback actualStart');
          summary.advancedAssignments += 1;
        } else {
          summary.skips.push(`assignment:${id}:start_cas_miss`);
        }
      } else if (hasEnd && (a.status === 'executing' || a.status === 'dispatched')) {
        const fromStatus = a.status;
        const hit = await this.db
          .update(ewohSchedulingPlanAssignment)
          .set({ status: 'completed' })
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.assignmentId, id),
              eq(ewohSchedulingPlanAssignment.status, fromStatus),
            ),
          )
          .returning({ id: ewohSchedulingPlanAssignment.id });
        if (hit.length > 0) {
          await this.insertAssignmentEvent(id, a.taskId ?? null, fromStatus, 'completed', ctx, 'execution feedback actualEnd');
          summary.advancedAssignments += 1;
        } else {
          summary.skips.push(`assignment:${id}:end_cas_miss`);
        }
      } else if (hasStart && a.status === 'executing') {
        // 已一致（幂等 no-op）
        summary.skips.push(`assignment:${id}:start_already_executing`);
      } else if (hasEnd && a.status === 'completed') {
        summary.skips.push(`assignment:${id}:end_already_completed`);
      } else {
        summary.skips.push(`assignment:${id}:out_of_order_from_${a.status ?? 'unknown'}`);
      }
    }

    // 3) task 推进（契约状态机最短合法链；边界见 ADR-050 决策 2）。
    if (!this.taskService || affectedTaskIds.size === 0) return;
    const tasks = await this.db
      .select()
      .from(ewohProductionTask)
      .where(inArray(ewohProductionTask.id, [...affectedTaskIds]));
    for (const task of tasks) {
      const id = String(task.id);
      try {
        if (hasStart && (task.status === 'dispatched' || task.status === 'received')) {
          const path = taskActionPath(task.status, 'executing');
          for (const action of path ?? []) {
            await this.taskService.transitionTaskState(id, action, ctx);
            summary.advancedTaskSteps += 1;
          }
        } else if (hasEnd && ['executing', 'received', 'paused'].includes(task.status)) {
          const path = taskActionPath(task.status, 'completed');
          for (const action of path ?? []) {
            await this.taskService.transitionTaskState(id, action, ctx);
            summary.advancedTaskSteps += 1;
          }
        } else if (hasStart && task.status === 'executing') {
          summary.skips.push(`task:${id}:start_already_executing`);
        } else if (hasEnd && (task.status === 'completed' || task.status === 'cancelled')) {
          summary.skips.push(`task:${id}:end_already_terminal`);
        } else {
          summary.skips.push(`task:${id}:out_of_order_from_${task.status ?? 'unknown'}`);
        }
      } catch (err) {
        // 推进失败显式留痕（§33 不吞异常——状态推进失败不阻断反馈主流程）。
        this.logger.warn(
          `execution advancement task ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.skips.push(`task:${id}:advance_failed`);
      }
    }
  }

  private async insertAssignmentEvent(
    assignmentId: string,
    taskId: string | null,
    fromStatus: string,
    toStatus: string,
    ctx: OrgContext,
    reason: string,
  ): Promise<void> {
    await this.db.insert(ewohAssignmentEvent).values({
      // R2-SSV-20：Date.now()+Math.random（同毫秒碰撞）→ randomUUID。
      eventId: `EVT-${randomUUID()}`,
      assignmentId,
      taskId,
      fromStatus,
      toStatus,
      actor: ctx.userId || 'system',
      reason,
    });
  }

  /**
   * R2-SSV-13：可信推进调用方判定——system（内部流）、dispatcher /
   * global_admin / device_ops（调度/设备运维角色）可代录；其余调用方必须
   * 是受派 assignment 的 personId 本人（见 applyExecutionAdvancement 内校验）。
   */
  private isTrustedAdvancementActor(ctx: OrgContext): boolean {
    if (!ctx.userId || ctx.userId === 'system') return true;
    if (ctx.isGlobalAdmin) return true;
    const roles = new Set<string>([
      ...(ctx.roles ?? []),
      ...(ctx.role ? [ctx.role] : []),
    ]);
    return roles.has('dispatcher') || roles.has('global_admin') || roles.has('device_ops');
  }

  /** 读取指定 plan 的反馈行（离线评估视图）。 */
  async listForPlan(planId: string): Promise<SchedulingFeedback[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(eq(ewohSchedulingFeedback.planId, planId));
    return rows.map((r) => this.toFeedback(r));
  }

  /**
   * 全部反馈行（离线评估视图）。NEST-108：HTTP 上下文强制 orgId。
   * R2-SSV-26（2026-08-17）：globalScope 显式放行全局聚合（scope=ALL 语义，
   * 供无 primaryOrgId 的 global_admin 跨租户运维视角；非 global 调用方不变）。
   */
  async list(
    orgId?: string | null,
    opts?: { globalScope?: boolean },
  ): Promise<SchedulingFeedback[]> {
    // NEST-108 修复（2026-08-17）：HTTP 请求上下文内 orgId 必传（无 org 即
    // 全表反馈暴露）；系统后台流（无 request context）保持全量系统语义。
    if (!orgId && !opts?.globalScope && currentRequestContext()) {
      throw new BadRequestException(
        'orgId required for feedback listing（NEST-108）',
      );
    }
    // ADR-073：feedback 读面 org 条件（org 匹配或 NULL 存量；RLS 语义等价）。
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingFeedback)
          .where(
            or(
              isNull(ewohSchedulingFeedback.orgId),
              eq(ewohSchedulingFeedback.orgId, orgId),
            ),
          )
      : await this.db.select().from(ewohSchedulingFeedback);
    return rows.map((r) => this.toFeedback(r));
  }

  /**
   * 由反馈表派生调度 KPI（acceptanceRate / overrideRate / fallbackRate / solverRuntime +
   * Phase 4 / P4-T1 扩展：on-time rate / mean+P95 lateness / total travel / workload imbalance /
   * plan churn / conflict rate / replan success rate）。输入缺省时显式 null 标注缺数据，不伪造。
   * R2-SSV-26：globalScope 显式放行全局聚合（同 list；global_admin 语义）。
   */
  async deriveKpis(
    orgId?: string | null,
    opts?: { globalScope?: boolean },
  ): Promise<SchedulingFeedbackKpis> {
    // NEST-108：同 list——HTTP 上下文内 orgId 必传（无认证调用不再全表 KPI）。
    if (!orgId && !opts?.globalScope && currentRequestContext()) {
      throw new BadRequestException(
        'orgId required for KPI derivation（NEST-108）',
      );
    }
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingFeedback)
          .where(
            or(
              isNull(ewohSchedulingFeedback.orgId),
              eq(ewohSchedulingFeedback.orgId, orgId),
            ),
          )
      : await this.db.select().from(ewohSchedulingFeedback);
    const total = rows.length;
    let accepted = 0;
    let rejected = 0;
    let overrideRows = 0;
    let fallbackRows = 0;
    let runtimeSum = 0;
    let runtimeCount = 0;
    let replanCount = 0;
    let conflictCount = 0;

    for (const r of rows) {
      if (r.accepted === true) accepted += 1;
      else if (r.accepted === false) rejected += 1;
      if ((r.overrideCount ?? 0) > 0) overrideRows += 1;
      if (r.solverFallback) fallbackRows += 1;
      if (r.solverRuntime != null) {
        runtimeSum += r.solverRuntime;
        runtimeCount += 1;
      }
      replanCount += r.replanCount ?? 0;
      conflictCount += r.conflictCount ?? 0;
    }

    const decided = accepted + rejected;

    // ---- Phase 4 / P4-T1：扩展 KPI（缺失数据显式 null） ----
    // on-time / lateness：需 plannedEnd + actualEnd 成对。
    const lateness: number[] = [];
    let onTime = 0;
    for (const r of rows) {
      if (!r.plannedEnd || !r.actualEnd) continue;
      const ms = r.actualEnd.getTime() - r.plannedEnd.getTime();
      lateness.push(ms);
      if (ms <= 0) onTime += 1;
    }
    const onTimeRate =
      lateness.length > 0 ? onTime / lateness.length : null;
    const sortedLateness = [...lateness].sort((a, b) => a - b);
    const meanLatenessMs =
      sortedLateness.length > 0
        ? sortedLateness.reduce((s, v) => s + v, 0) / sortedLateness.length
        : null;
    const p95LatenessMs =
      sortedLateness.length > 0
        ? sortedLateness[Math.min(
            Math.ceil(sortedLateness.length * 0.95) - 1,
            sortedLateness.length - 1,
          )]
        : null;

    // total travel：plannedTravel 为 etaSeconds 语义 → ms。
    const travelSeconds = rows
      .map((r) => r.plannedTravel)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const totalTravelMs =
      travelSeconds.length > 0
        ? travelSeconds.reduce((s, v) => s + v, 0) * 1000
        : null;

    // workload imbalance：同 person 的任务数 max-min（>=2 人数据才有意义）。
    const perPerson = new Map<string, number>();
    for (const r of rows) {
      const pid = (r.originalResourceJson as { personId?: string | null } | null)?.personId;
      if (!pid) continue;
      perPerson.set(pid, (perPerson.get(pid) ?? 0) + 1);
    }
    const personCounts = [...perPerson.values()];
    const workloadImbalance =
      personCounts.length >= 2
        ? Math.max(...personCounts) - Math.min(...personCounts)
        : null;

    // plan churn：Σ replanCount（重排次数代理）。
    const planChurn = replanCount > 0 ? replanCount : null;

    // conflict rate：Σ conflictCount / totalFeedback（每方案平均冲突数）。
    const conflictRate = total > 0 ? conflictCount / total : null;

    // replan success rate：重排过的行中 accepted=true 占比。
    const replanRows = rows.filter((r) => (r.replanCount ?? 0) > 0);
    const replanAccepted = replanRows.filter((r) => r.accepted === true).length;
    const replanSuccessRate =
      replanRows.length > 0 ? replanAccepted / replanRows.length : null;

    return {
      totalFeedback: total,
      accepted,
      rejected,
      pendingAcceptance: total - decided,
      acceptanceRate: decided > 0 ? accepted / decided : 0,
      overrideRate: total > 0 ? overrideRows / total : 0,
      fallbackRate: total > 0 ? fallbackRows / total : 0,
      solverRuntimeMs: runtimeCount > 0 ? runtimeSum / runtimeCount : 0,
      replanCount,
      conflictCount,
      onTimeRate,
      meanLatenessMs,
      p95LatenessMs,
      totalTravelMs,
      workloadImbalance,
      planChurn,
      conflictRate,
      replanSuccessRate,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private isFallbackStatus(status?: string): boolean {
    if (!status) return false;
    return ['UNAVAILABLE', 'FALLBACK', 'TIMEOUT', 'INFEASIBLE'].includes(
      status.toUpperCase(),
    );
  }

  private toFeedback(
    r: typeof ewohSchedulingFeedback.$inferSelect,
  ): SchedulingFeedback {
    return {
      feedbackId: r.feedbackId,
      runId: r.runId ?? null,
      planId: r.planId,
      taskId: r.taskId ?? null,
      assignmentId: r.assignmentId ?? null,
      plannedStart: r.plannedStart ? r.plannedStart.toISOString() : null,
      actualStart: r.actualStart ? r.actualStart.toISOString() : null,
      plannedEnd: r.plannedEnd ? r.plannedEnd.toISOString() : null,
      actualEnd: r.actualEnd ? r.actualEnd.toISOString() : null,
      plannedTravel: r.plannedTravel ?? null,
      actualTravel: r.actualTravel ?? null,
      plannedWait: r.plannedWait ?? null,
      actualWait: r.actualWait ?? null,
      originalResource: (r.originalResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      actualResource: (r.actualResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      replanCount: r.replanCount ?? 0,
      conflictCount: r.conflictCount ?? 0,
      overrideCount: r.overrideCount ?? 0,
      solverRuntime: r.solverRuntime ?? null,
      solverFallback: r.solverFallback ?? false,
      accepted: r.accepted ?? null,
      ts: r.ts ? r.ts.toISOString() : new Date().toISOString(),
    };
  }

}