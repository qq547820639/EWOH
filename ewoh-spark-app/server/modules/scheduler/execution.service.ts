import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, or, isNull } from 'drizzle-orm';
import { ewohSchedulingExecution } from '@server/database/schema';
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
   * 由 Plan Assignment 批量创建 Execution（dispatch 时调用；幂等：assignment 已存在则跳过）。
   * 只记录计划事实，不产生业务副作用。
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
    const created: SchedulingExecution[] = [];
    for (const a of assignments) {
      const existing = await this.db
        .select()
        .from(ewohSchedulingExecution)
        .where(eq(ewohSchedulingExecution.assignmentId, a.assignmentId))
        .limit(1);
      if (existing[0]) continue;
      const executionId = `EXEC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const [row] = await this.db
        .insert(ewohSchedulingExecution)
        .values({
          executionId,
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
        })
        .returning();
      created.push(this.toExecution(row));
      void ctx;
    }
    return created;
  }

  /** 幂等状态转换（终态不可再迁移）。返回更新后的 Execution。 */
  async update(
    assignmentId: string,
    body: ExecutionUpdateRequest,
    orgId: string | null,
  ): Promise<SchedulingExecution> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulingExecution)
      .where(eq(ewohSchedulingExecution.assignmentId, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException(`Execution for assignment ${assignmentId} not found`);

    const current = this.toExecution(row);
    const target = (body.status ?? current.status) as SchedulingExecutionStatus;
    const terminal = new Set<SchedulingExecutionStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);
    if (terminal.has(current.status) && current.status !== target) {
      throw new NotFoundException(
        `Execution ${row.executionId} already terminal (${current.status}); refusing transition to ${target}`,
      );
    }

    const deviationType = (body.deviationType ?? current.deviationType) as SchedulingDeviationType;
    const values: Record<string, unknown> = {};
    if (body.status) values.status = target;
    if (body.actualStartAt != null) values.actualStartAt = new Date(body.actualStartAt);
    if (body.actualEndAt != null) values.actualEndAt = new Date(body.actualEndAt);
    if (body.actualTravelMs != null) values.actualTravelMs = body.actualTravelMs;
    if (body.actualDistanceM != null) values.actualDistanceM = body.actualDistanceM;
    if (body.actualWaitingMs != null) values.actualWaitingMs = body.actualWaitingMs;
    if (body.deviationType) values.deviationType = deviationType;
    if (body.deviationReason != null) values.deviationReason = body.deviationReason;

    const [updated] = await this.db
      .update(ewohSchedulingExecution)
      .set(values)
      .where(eq(ewohSchedulingExecution.assignmentId, assignmentId))
      .returning();
    const execution = this.toExecution(updated);

    // 派生偏差：actual 与 planned 对比（仅在提供 actual 时判定；不猜测）。
    if (deviationType == null) {
      const derived = this.deriveDeviation(execution);
      if (derived) {
        await this.db
          .update(ewohSchedulingExecution)
          .set({ deviationType: derived.type, deviationReason: derived.reason })
          .where(eq(ewohSchedulingExecution.assignmentId, assignmentId));
        execution.deviationType = derived.type;
        execution.deviationReason = derived.reason;
      }
    }

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

  /** 查询：按 plan / task / status 过滤。 */
  async list(opts: {
    planId?: string;
    taskId?: string;
    status?: string;
    orgId?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<ExecutionListResponse> {
    const conditions = [];
    if (opts.planId) conditions.push(eq(ewohSchedulingExecution.planId, opts.planId));
    if (opts.taskId) conditions.push(eq(ewohSchedulingExecution.taskId, opts.taskId));
    if (opts.status) conditions.push(eq(ewohSchedulingExecution.status, opts.status));
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
    const rows = await this.db
      .select()
      .from(ewohSchedulingExecution)
      .where(where)
      .orderBy(desc(ewohSchedulingExecution.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return { executions: rows.map((r) => this.toExecution(r)), total: rows.length };
  }

  /** 按 assignmentId 查。 */
  async getByAssignment(assignmentId: string): Promise<SchedulingExecution | null> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulingExecution)
      .where(eq(ewohSchedulingExecution.assignmentId, assignmentId))
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
    try {
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
    } catch (err) {
      this.logger.warn(`execution event publish failed: ${(err as Error)?.message ?? err}`);
    }
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
