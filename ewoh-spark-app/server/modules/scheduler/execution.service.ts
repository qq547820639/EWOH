import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, count, desc, eq, inArray, or, isNull } from 'drizzle-orm';
import { ewohSchedulingExecution, ewohProductionTask, ewohPersonnel } from '@server/database/schema';
import type {
  ExecutionListResponse,
  ExecutionUpdateRequest,
  SchedulingDeviationType,
  SchedulingExecution,
  SchedulingExecutionStatus,
} from '@shared/api.interface';
import { OutboxService } from './outbox.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { executionReceiptPatch } from './execution-receipt-state';

/**
 * 正式执行领域（Phase 4 / P4-EXEC）。
 *
 * 职责：
 * - 由 Plan Assignment 创建 Execution（PLANNED）；
 * - dispatch 后流转 DISPATCHED → STARTED → COMPLETED/FAILED/CANCELLED（幂等 CAS）；
 * - 记录 planned vs actual（开始/结束/行程/等待），派生 deviation（事实，不猜测）；
 * - 符合规则的 deviation 通过 outbox 发布 execution.deviation 事件，由外部
 *   TriggerService/ReplanCoordinator 消费触发局部重排（保持 debounce/cooldown/
 *   frozen/churn 语义——不在此服务内自行重排）。
 *
 * 状态机（幂等）：终态 COMPLETED/FAILED/CANCELLED 不可再迁移。
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  /** 触发 replan 的 deviation 规则（其余 deviation 只记录不重排）。 */
  private static readonly REPLANNABLE_DEVIATIONS: ReadonlySet<string> = new Set([
    'PERSON_UNAVAILABLE',
    'DEVICE_FAILURE',
    'ROUTE_DEVIATION',
    'TASK_CANCELLED',
    'SAFETY_INTERRUPTION',
  ]);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly outboxService: OutboxService,
    private readonly metricsService: SchedulerMetricsService,
  ) {}

  /**
   * DR-5 方案取消/回滚：把未开始的 Execution 行标记 CANCELLED（幂等 CAS——
   * 仅非终态行迁移；已 STARTED/COMPLETED 的执行保持原状，物理执行不可撤销）。
   */
  async cancelForAssignments(assignmentIds: string[], actor?: OrgContext): Promise<number> {
    if (assignmentIds.length === 0) return 0;
    const rows = await this.db
      .update(ewohSchedulingExecution)
      .set({ status: 'CANCELLED' })
      .where(
        and(
          inArray(ewohSchedulingExecution.assignmentId, assignmentIds),
          inArray(ewohSchedulingExecution.status, ['PLANNED', 'DISPATCHED']),
        ),
      )
      .returning({ executionId: ewohSchedulingExecution.executionId });
    if (rows.length > 0) {
      this.logger.log(
        `plan cancel: ${rows.length} execution(s) marked CANCELLED by ${actor?.userId ?? 'system'}`,
      );
    }
    return rows.length;
  }

  /**
   * 由 Plan Assignment 批量创建 Execution（dispatch 时调用；幂等：assignment 已存在则跳过）。
   * 只记录计划事实，不产生业务副作用。
   *
   * P1（2026-08-19 审计）：原逐 assignment 循环 INSERT（N+1 次往返——dispatch
   * 大方案 N=任务数，典型数百次）→ 单条批量 INSERT。幂等语义保持：
   * - org 非空路径：ON CONFLICT DO NOTHING（target=(org_id, assignment_id)，
   *   standalone_057 复合唯一）原子防并发双插，冲突行不返回即跳过；
   * - orgId 为 NULL 的系统路径不可作 conflict target（PG 中 NULL != NULL 不
   *   命中唯一索引）：一次性批量查询已存在 assignmentId 后过滤（原逐条
   *   存在性检查的批量化等价），并对入参批内 assignmentId 去重。
   */
  async createFromPlan(
    plan: { planId: string; runId?: string | null; snapshotVersion?: string | null; policyVersion?: number | null; solverVersion?: string | null },
    assignments: Array<{
      assignmentId: string;
      taskId: string;
      personId: string | null;
      deviceId: string | null;
      stationId: string | null;
      plannedStart: string | null;
      plannedEnd: string | null;
      etaSeconds?: number;
      distanceMeters?: number;
    }>,
    orgId: string | null,
    ctx?: OrgContext,
  ): Promise<SchedulingExecution[]> {
    void ctx;
    // 入批内去重（null-org 路径原靠逐条前置检查间接去重，批量化后显式化）。
    const seen = new Set<string>();
    const unique = assignments.filter((a) => {
      if (seen.has(a.assignmentId)) return false;
      seen.add(a.assignmentId);
      return true;
    });
    if (unique.length === 0) return [];

    let pending = unique;
    if (orgId == null) {
      const existingRows = await this.db
        .select({ assignmentId: ewohSchedulingExecution.assignmentId })
        .from(ewohSchedulingExecution)
        .where(
          inArray(
            ewohSchedulingExecution.assignmentId,
            unique.map((a) => a.assignmentId),
          ),
        );
      const existing = new Set(existingRows.map((r) => r.assignmentId));
      pending = unique.filter((a) => !existing.has(a.assignmentId));
    }
    if (pending.length === 0) return [];

    // NEST-047：randomUUID（密码学随机）。
    const inserted = await this.db
      .insert(ewohSchedulingExecution)
      .values(
        pending.map((a) => ({
          executionId: `EXEC-${randomUUID()}`,
          orgId,
          runId: plan.runId ?? null,
          planId: plan.planId,
          assignmentId: a.assignmentId,
          taskId: a.taskId,
          personId: a.personId,
          deviceId: a.deviceId,
          stationId: a.stationId,
          plannedStartAt: a.plannedStart ? new Date(a.plannedStart) : null,
          plannedEndAt: a.plannedEnd ? new Date(a.plannedEnd) : null,
          plannedTravelMs: a.etaSeconds != null ? Math.round(a.etaSeconds * 1000) : null,
          plannedDistanceM: a.distanceMeters ?? null,
          status: 'PLANNED',
          snapshotVersion: plan.snapshotVersion ?? null,
          policyVersion: plan.policyVersion ?? null,
          solverVersion: plan.solverVersion ?? null,
          source: 'dispatch',
        })),
      )
      .onConflictDoNothing({
        target: [
          ewohSchedulingExecution.orgId,
          ewohSchedulingExecution.assignmentId,
        ],
      })
      .returning();
    return inserted.map((row) => this.toExecution(row));
  }

  /** 幂等状态转换（终态不可再迁移）。返回更新后的 Execution。 */
  async update(
    assignmentId: string,
    body: ExecutionUpdateRequest,
    orgId: string | null,
  ): Promise<SchedulingExecution> {
    const ownership = orgId ? eq(ewohSchedulingExecution.orgId, orgId) : isNull(ewohSchedulingExecution.orgId);
    const [row] = await this.db.select().from(ewohSchedulingExecution)
      .where(and(eq(ewohSchedulingExecution.assignmentId, assignmentId), ownership)).limit(1);
    if (!row) throw new NotFoundException(`Execution for assignment ${assignmentId} not found`);
    const current = this.toExecution(row);
    const values = executionReceiptPatch(current, body);
    // An exact retry is a read: no duplicate outbox entry, timestamp or metrics.
    if (Object.keys(values).length === 0) return current;
    const projected = { ...current, ...values,
      actualStartAt: values.actualStartAt instanceof Date ? values.actualStartAt.toISOString() : current.actualStartAt,
      actualEndAt: values.actualEndAt instanceof Date ? values.actualEndAt.toISOString() : current.actualEndAt,
    } as SchedulingExecution;
    if (!projected.deviationType) {
      const derived = this.deriveDeviation(projected);
      if (derived) { values.deviationType = derived.type; values.deviationReason = derived.reason; }
    }
    const [updated] = await this.db.update(ewohSchedulingExecution).set(values).where(and(
      eq(ewohSchedulingExecution.id, row.id), ownership,
      eq(ewohSchedulingExecution.status, row.status),
      row.actualStartAt ? eq(ewohSchedulingExecution.actualStartAt, row.actualStartAt) : isNull(ewohSchedulingExecution.actualStartAt),
      row.actualEndAt ? eq(ewohSchedulingExecution.actualEndAt, row.actualEndAt) : isNull(ewohSchedulingExecution.actualEndAt),
    )).returning();
    if (!updated) throw new ConflictException('EXECUTION_STATE_CONFLICT');
    const execution = this.toExecution(updated);

    // 观测 + 事件
    if (body.status && body.status !== current.status) {
      try {
        this.metricsService.recordExecutionTransition(execution.status);
      } catch {
        // 指标失败不阻断
      }
    }
    await this.publishEvent(execution, orgId, body.triggerReplan ?? true);

    return execution;
  }

  /**
   * 查询：按 plan / task / status / person 过滤。
   *
   * `personId`（2026-09-10 现场作业台）：现场视角必须只看到"分配给我的"执行
   * 记录。此前只有 plan/task/status 三个过滤条件，现场页只能拉全量再在前端
   * 过滤——既浪费带宽，也让"我的任务"依赖客户端正确性。归属筛选放在服务端
   * 并保持租户作用域（orgId 条件不受影响）。
   */
  async list(opts: {
    planId?: string;
    taskId?: string;
    status?: string;
    personId?: string;
    orgId?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<ExecutionListResponse> {
    const conditions = [];
    if (opts.planId) conditions.push(eq(ewohSchedulingExecution.planId, opts.planId));
    if (opts.taskId) conditions.push(eq(ewohSchedulingExecution.taskId, opts.taskId));
    if (opts.status) conditions.push(eq(ewohSchedulingExecution.status, opts.status));
    if (opts.personId) conditions.push(eq(ewohSchedulingExecution.personId, opts.personId));
    // ADR-073：execution 读面 org 条件（org 匹配或 NULL 存量）。
    if (opts.orgId) {
      conditions.push(
        or(
          isNull(ewohSchedulingExecution.orgId),
          eq(ewohSchedulingExecution.orgId, opts.orgId),
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    // P2（2026-08-19 审计）分页 total 语义：原 total 取当前页 rows.length
    // （≤limit），翻页/前端分页控件全部失真——改为独立 count(*) 查询满足
    // where 条件的总数（与 dashboard.service 分页同款正确实现）。
    const [rows, totalRow] = await Promise.all([
      this.db
        .select()
        .from(ewohSchedulingExecution)
        .where(where)
        .orderBy(desc(ewohSchedulingExecution.createdAt))
        .limit(opts.limit ?? 100)
        .offset(opts.offset ?? 0),
      this.db
        .select({ value: count() })
        .from(ewohSchedulingExecution)
        .where(where),
    ]);
    const executions = rows.map((r) => this.toExecution(r));
    await this.attachDisplayNames(executions);
    return {
      executions,
      total: totalRow[0]?.value ?? rows.length,
    };
  }

  /**
   * 批量回填展示字段（taskTitle / personName，2026-09-11）。
   *
   * 执行记录本体只存 ID；但 raw UUID 直接呈现给班组长/调度员不可读。
   * 这里按当前页的 distinct ID 批量解析（两次 in-list 查询，不逐行 N+1）。
   * RLS 生效下目标不在本租户时解析不到——留 null 由 UI 显示"未知"，
   * 绝不回退显示 ID 或伪造名称。
   */
  private async attachDisplayNames(executions: SchedulingExecution[]): Promise<void> {
    const taskIds = [...new Set(executions.map((e) => e.taskId).filter(Boolean))];
    const personIds = [...new Set(executions.map((e) => e.personId).filter((id): id is string => Boolean(id)))];
    if (taskIds.length === 0 && personIds.length === 0) return;
    const [taskRows, personRows] = await Promise.all([
      taskIds.length > 0
        ? this.db
          .select({ id: ewohProductionTask.id, title: ewohProductionTask.title })
          .from(ewohProductionTask)
          .where(inArray(ewohProductionTask.id, taskIds))
        : Promise.resolve([] as Array<{ id: string; title: string }>),
      personIds.length > 0
        ? this.db
          .select({ id: ewohPersonnel.id, name: ewohPersonnel.name })
          .from(ewohPersonnel)
          .where(inArray(ewohPersonnel.id, personIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const taskTitles = new Map(taskRows.map((row) => [row.id, row.title]));
    const personNames = new Map(personRows.map((row) => [row.id, row.name]));
    for (const execution of executions) {
      execution.taskTitle = taskTitles.get(execution.taskId) ?? null;
      execution.personName = execution.personId ? (personNames.get(execution.personId) ?? null) : null;
    }
  }

  /** 按 assignmentId 查。NEST-012（2026-08-17）：orgId 提供时按 org 过滤。 */
  async getByAssignment(
    assignmentId: string,
    orgId?: string | null,
  ): Promise<SchedulingExecution | null> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulingExecution)
      .where(
        and(
          eq(ewohSchedulingExecution.assignmentId, assignmentId),
          orgId
            ? or(
                isNull(ewohSchedulingExecution.orgId),
                eq(ewohSchedulingExecution.orgId, orgId),
              )
            : undefined,
        ),
      )
      .limit(1);
    return row ? this.toExecution(row) : null;
  }

  /** 批量查（KPI 聚合用）。 */
  async listAll(orgId?: string | null): Promise<SchedulingExecution[]> {
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingExecution)
          .where(eq(ewohSchedulingExecution.orgId, orgId))
      : await this.db.select().from(ewohSchedulingExecution);
    return rows.map((r) => this.toExecution(r));
  }

  /**
   * deviation 派生（纯函数，事实判定）：actual 与 planned 对比。
   * 无 actual 数据不猜测；只输出最显著的一类偏差。
   */
  private deriveDeviation(e: SchedulingExecution): { type: SchedulingDeviationType; reason: string } | null {
    if (e.status === 'CANCELLED') return { type: 'TASK_CANCELLED', reason: 'execution cancelled' };
    if (e.status === 'FAILED') return { type: 'DEVICE_FAILURE', reason: e.deviationReason ?? 'execution failed' };
    if (e.actualStartAt && e.plannedStartAt) {
      const delayMs = new Date(e.actualStartAt).getTime() - new Date(e.plannedStartAt).getTime();
      if (delayMs > 60_000) {
        return { type: 'START_DELAY', reason: `start delayed ${Math.round(delayMs / 1000)}s` };
      }
    }
    if (e.actualEndAt && e.plannedEndAt) {
      const delayMs = new Date(e.actualEndAt).getTime() - new Date(e.plannedEndAt).getTime();
      if (delayMs > 60_000) {
        return { type: 'END_DELAY', reason: `end delayed ${Math.round(delayMs / 1000)}s` };
      }
    }
    if (e.actualTravelMs != null && e.plannedTravelMs != null && e.actualTravelMs > e.plannedTravelMs * 1.5) {
      return { type: 'TRAVEL_DELAY', reason: `travel ${e.actualTravelMs}ms vs planned ${e.plannedTravelMs}ms` };
    }
    return null;
  }

  /** 发布 execution 事件（envelope 经 outbox；replan 规则命中时由消费方触发重排）。 */
  private async publishEvent(
    e: SchedulingExecution,
    orgId: string | null,
    triggerReplan = true,
  ): Promise<void> {
    const isDeviation = e.deviationType != null;
    const shouldReplan =
      isDeviation && triggerReplan && ExecutionService.REPLANNABLE_DEVIATIONS.has(e.deviationType ?? '');
    await this.outboxService.enqueue(
        isDeviation ? 'execution.deviation' : 'execution.updated',
        e.assignmentId,
        {
          executionId: e.executionId,
          planId: e.planId,
          taskId: e.taskId,
          assignmentId: e.assignmentId,
          status: e.status,
          deviationType: e.deviationType,
          deviationReason: e.deviationReason,
          triggerReplan: shouldReplan,
          snapshotVersion: e.snapshotVersion,
          correlationId: e.runId ?? e.executionId,
        },
        orgId,
        undefined,
        {
          entityType: 'assignment',
          entityVersion: undefined,
          snapshotVersion: e.snapshotVersion,
          planId: e.planId,
          occurredAt: new Date().toISOString(),
        },
      );
  }

  private toExecution(r: typeof ewohSchedulingExecution.$inferSelect): SchedulingExecution {
    return {
      id: r.id,
      executionId: r.executionId,
      orgId: r.orgId ?? null,
      runId: r.runId ?? null,
      planId: r.planId,
      assignmentId: r.assignmentId,
      taskId: r.taskId,
      personId: r.personId ?? null,
      deviceId: r.deviceId ?? null,
      stationId: r.stationId ?? null,
      plannedStartAt: r.plannedStartAt ? r.plannedStartAt.toISOString() : null,
      plannedEndAt: r.plannedEndAt ? r.plannedEndAt.toISOString() : null,
      actualStartAt: r.actualStartAt ? r.actualStartAt.toISOString() : null,
      actualEndAt: r.actualEndAt ? r.actualEndAt.toISOString() : null,
      plannedTravelMs: r.plannedTravelMs ?? null,
      actualTravelMs: r.actualTravelMs ?? null,
      plannedDistanceM: r.plannedDistanceM ?? null,
      actualDistanceM: r.actualDistanceM ?? null,
      plannedWaitingMs: r.plannedWaitingMs ?? null,
      actualWaitingMs: r.actualWaitingMs ?? null,
      status: (r.status as SchedulingExecutionStatus) ?? 'PLANNED',
      deviationType: (r.deviationType as SchedulingDeviationType) ?? null,
      deviationReason: r.deviationReason ?? null,
      snapshotVersion: r.snapshotVersion ?? null,
      policyVersion: r.policyVersion ?? null,
      solverVersion: r.solverVersion ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : '',
    };
  }
}
