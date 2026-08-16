import { BadRequestException, Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohAgentTask, ewohEvent } from '@server/database/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { validateAgentTask, agentTaskTransitionAllowed } from '@shared/agent-task';
import { isCatalogEventType } from '@shared/event-catalog';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { AuditService } from '../shared/audit.service';

export type AgentTaskInput = Record<string, unknown>;

/** 每 (org, assignedRole) 活跃任务并发预算（防多 Agent 风暴）。 */
export const AGENT_ROLE_CONCURRENCY_LIMIT = 10;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * AgentTask 编排服务（ADR-017 / NO-06f）。
 *
 * - 创建唯一入口：validateAgentTask 契约校验 fail-closed + 依赖环检测
 *   （跨任务 BFS）＋并发预算（每角色活跃任务数上限）＋落库 + AgentTaskCreated
 *   事件；同版本幂等重创建；
 * - 状态推进唯一写者：start（dispatched→in_progress）/ complete（in_progress→
 *   completed|failed）/ cancel（非终态→cancelled）——转移经
 *   agentTaskTransitionAllowed（状态机 yaml 同源）+ DB CAS（where status=当前）；
 * - 依赖门控：dispatch 前所有 dependencies 必须 completed（fail-closed）；
 * - 终态落 AgentTaskCompleted 事件（outcome 留痕）+ 审计同源。
 */
@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  // ── 创建（唯一入口，契约校验 fail-closed） ────────────────────────────────

  async createTask(
    orgId: string,
    task: AgentTaskInput,
    actor?: { userId: string },
  ): Promise<AgentTaskInput> {
    if (!orgId?.trim()) {
      throw new BadRequestException('org 上下文缺失，任务创建显式失败');
    }
    const errors = validateAgentTask(task);
    if (errors.length > 0) {
      throw new BadRequestException(`agent_task_invalid:${errors[0]}`);
    }
    const taskId = task.taskId as string;
    const existing = await this.db
      .select()
      .from(ewohAgentTask)
      .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, taskId)));
    if (existing.length > 0) {
      const currentVersion = existing[0]?.version ?? 0;
      const newVersion = task.version as number;
      if (newVersion < currentVersion) {
        throw new BadRequestException(`task_version_regression:${newVersion}<${currentVersion}`);
      }
      if (newVersion === currentVersion) {
        return existing[0]?.taskJson as AgentTaskInput; // 幂等重创建
      }
    }
    // 依赖环检测（跨任务 BFS：新任务不得出现在任一依赖的传递闭包中）
    const dependencies = (task.dependencies ?? []) as string[];
    if (dependencies.length > 0) {
      const seen = new Set<string>();
      const queue = [...dependencies];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (current === taskId) {
          throw new BadRequestException('task_graph_cycle');
        }
        if (seen.has(current)) continue;
        seen.add(current);
        const rows = await this.db
          .select({ dependencies: ewohAgentTask.dependencies })
          .from(ewohAgentTask)
          .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, current)));
        for (const row of rows) {
          const nextDeps = (row.dependencies ?? []) as string[];
          for (const dep of nextDeps) queue.push(dep);
        }
      }
    }
    // 并发预算：每 (org, role) 活跃任务数上限
    const assignedRole = task.assignedRole as string;
    const activeRows = await this.db
      .select({ taskId: ewohAgentTask.taskId })
      .from(ewohAgentTask)
      .where(
        and(
          eq(ewohAgentTask.orgId, orgId),
          eq(ewohAgentTask.assignedRole, assignedRole),
          inArray(ewohAgentTask.status, ['created', 'dispatched', 'in_progress']),
        ),
      );
    if (activeRows.length >= AGENT_ROLE_CONCURRENCY_LIMIT) {
      throw new BadRequestException(
        `concurrency_limit_exceeded:${assignedRole}=${AGENT_ROLE_CONCURRENCY_LIMIT}`,
      );
    }

    const dueTimeRaw = task.dueTime as string | undefined;
    await this.db.insert(ewohAgentTask).values({
      orgId,
      taskId,
      name: task.name as string,
      version: task.version as number,
      kind: task.kind as string,
      assignedRole,
      assigneeAgentId: (task.assigneeAgentId as string | undefined) ?? null,
      dependencies: task.dependencies as string[],
      priority: task.priority as string,
      status: 'created',
      dueTime: dueTimeRaw ? new Date(dueTimeRaw) : null,
      budget: task.budget as Record<string, unknown>,
      correlationId: (task.correlationId as string | undefined) ?? null,
      inputContract: task.inputContract as Record<string, unknown>,
      outputContract: task.outputContract as Record<string, unknown>,
      taskJson: task,
    });
    await this.recordTaskEvent(orgId, task, 'AgentTaskCreated', {});
    await this.auditAppend(orgId, 'agent.task.created', taskId, actor);
    return task;
  }

  // ── 状态推进（唯一写者：状态机 + CAS） ────────────────────────────────────

  private async transition(
    orgId: string,
    taskId: string,
    target: string,
    allowedFrom: string[],
    actor?: { userId: string },
  ): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select()
      .from(ewohAgentTask)
      .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, taskId)));
    if (rows.length === 0) {
      throw new BadRequestException('agent_task_not_found');
    }
    const row = rows[0];
    if (!allowedFrom.includes(row.status)) {
      throw new BadRequestException(
        `invalid_transition:${row.status}->${target}`,
      );
    }
    if (target === 'dispatched') {
      // 依赖门控：所有依赖必须 completed
      const dependencies = (row.dependencies ?? []) as string[];
      if (dependencies.length > 0) {
        const depRows = await this.db
          .select({ taskId: ewohAgentTask.taskId, status: ewohAgentTask.status })
          .from(ewohAgentTask)
          .where(and(eq(ewohAgentTask.orgId, orgId), inArray(ewohAgentTask.taskId, dependencies)));
        const notCompleted = depRows.filter((d) => d.status !== 'completed').map((d) => d.taskId);
        if (notCompleted.length > 0) {
          throw new BadRequestException(
            `dependency_not_completed:${notCompleted.join(',')}`,
          );
        }
      }
    }
    // CAS：状态推进唯一写者（where status=当前 → 0 行 = 并发冲突 fail-closed）
    const updated = await this.db
      .update(ewohAgentTask)
      .set({ status: target })
      .where(
        and(
          eq(ewohAgentTask.orgId, orgId),
          eq(ewohAgentTask.taskId, taskId),
          eq(ewohAgentTask.status, row.status),
        ),
      )
      .returning({ taskId: ewohAgentTask.taskId });
    if (updated.length === 0) {
      throw new BadRequestException('task_state_changed_concurrently');
    }
    if (TERMINAL_STATUSES.has(target)) {
      await this.recordTaskEvent(
        orgId,
        (row.taskJson ?? { taskId }) as AgentTaskInput,
        'AgentTaskCompleted',
        { status: target },
      );
    }
    await this.auditAppend(orgId, `agent.task.${target}`, taskId, actor);
    return { taskId, status: target };
  }

  async dispatchTask(orgId: string, taskId: string, actor?: { userId: string }) {
    return this.transition(orgId, taskId, 'dispatched', ['created'], actor);
  }

  async startTask(orgId: string, taskId: string, actor?: { userId: string }) {
    return this.transition(orgId, taskId, 'in_progress', ['dispatched'], actor);
  }

  async completeTask(
    orgId: string,
    taskId: string,
    outcome: { status: 'completed' | 'failed'; outcomeJson?: Record<string, unknown> },
    actor?: { userId: string },
  ) {
    if (outcome.status !== 'completed' && outcome.status !== 'failed') {
      throw new BadRequestException('completeTask status 必须为 completed|failed');
    }
    const result = await this.transition(
      orgId,
      taskId,
      outcome.status,
      ['in_progress'],
      actor,
    );
    if (outcome.outcomeJson) {
      await this.db
        .update(ewohAgentTask)
        .set({ taskJson: this.withOutcome(result, outcome.outcomeJson) })
        .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, taskId)));
    }
    return result;
  }

  async cancelTask(orgId: string, taskId: string, actor?: { userId: string }) {
    return this.transition(
      orgId,
      taskId,
      'cancelled',
      ['created', 'dispatched', 'in_progress'],
      actor,
    );
  }

  async listTasks(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db
      .select()
      .from(ewohAgentTask)
      .where(eq(ewohAgentTask.orgId, orgId))
      .orderBy(desc(ewohAgentTask.createdAt));
    return rows.map((r) => ({
      taskId: r.taskId,
      name: r.name,
      version: r.version,
      kind: r.kind,
      assignedRole: r.assignedRole,
      priority: r.priority,
      status: r.status,
      dependencies: r.dependencies,
      dueTime: r.dueTime ? r.dueTime.toISOString() : null,
      task: r.taskJson,
    }));
  }

  private withOutcome(
    result: Record<string, unknown>,
    outcomeJson: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...(result as object), outcomeJson } as Record<string, unknown>;
  }

  // ── 事件 + 审计 ───────────────────────────────────────────────────────────

  private async recordTaskEvent(
    orgId: string,
    task: AgentTaskInput,
    eventType: 'AgentTaskCreated' | 'AgentTaskCompleted',
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!isCatalogEventType(eventType)) {
        this.logger.error(`编排事件类型不在目录: ${eventType}`);
        return;
      }
      const now = new Date();
      const nowIso = now.toISOString();
      const taskId = task.taskId as string;
      const envelope = buildEventEnvelope({
        eventId: `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`,
        eventType,
        occurredAt: nowIso,
        observedAt: nowIso,
        receivedAt: nowIso,
        source: 'cloud:agent-orchestrator',
        subject: taskId,
      });
      const envelopeRecord = envelopeForEvidence(envelope);
      await this.db.insert(ewohEvent).values({
        eventId: envelope.eventId,
        deviceId: null,
        eventCode: eventType === 'AgentTaskCreated' ? 'AGENT_TASK_CREATED' : 'AGENT_TASK_COMPLETED',
        eventType,
        severity: 'low',
        title: `agent-task:${taskId} ${eventType}`,
        status: 'open',
        createdAt: now,
        sourceType: 'real',
        orgId,
        evidenceJson: {
          envelope: envelopeRecord.envelope,
          envelopeSemantics: envelopeRecord.envelopeSemantics,
          taskId,
          kind: task.kind ?? null,
          assignedRole: task.assignedRole ?? null,
          priority: task.priority ?? null,
          ...detail,
        },
      });
    } catch (error) {
      this.logger.error(`编排事件写入失败: ${String(error)}`);
    }
  }

  private async auditAppend(
    orgId: string,
    action: string,
    taskId: string,
    actor?: { userId: string },
  ): Promise<void> {
    try {
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'agent-orchestrator',
        orgId,
        action,
        entityType: 'agent_task',
        entityId: taskId,
        before: null,
        after: { taskId },
      });
    } catch (error) {
      this.logger.warn(`编排审计写入失败: ${String(error)}`);
    }
  }
}
