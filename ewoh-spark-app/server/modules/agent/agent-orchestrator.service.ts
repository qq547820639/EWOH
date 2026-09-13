import { BadRequestException, Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohAgentTask, ewohEvent } from '@server/database/schema';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { validateAgentTask, agentTaskTransitionAllowed } from '@shared/agent-task';
import { isCatalogEventType } from '@shared/event-catalog';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { AuditService } from '../shared/audit.service';

export type AgentTaskInput = Record<string, unknown>;

/** 任务转移调用方（roles 来自认证上下文 userContext.roles）。 */
export type AgentTaskActor = { userId: string; roles?: string[] };

/** SH-005：从 actor.roles 派生状态机执行主体角色（agent-task.yaml 转移表约束）。
 * roles 含 'agent'（Agent runtime 上报）→ agent；其余认证角色 → orchestrator
 * （平台/人侧调度）。roles 缺省（系统内部调用）→ undefined（契约向后兼容，
 * 不校验 role——但调用点必须显式传派生结果，禁止凭空省略）。 */
function deriveActorRole(actor?: AgentTaskActor): string | undefined {
  const roles = actor?.roles;
  if (!Array.isArray(roles) || roles.length === 0) return undefined;
  return roles.includes('agent') ? 'agent' : 'orchestrator';
}

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
    actor?: AgentTaskActor,
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
    // 依赖环检测（跨任务 BFS：新任务不得出现在任一依赖的传递闭包中）。
    // NEST-325：按层批量 inArray 查询（原先逐节点一查，大图 N+1）。
    const dependencies = (task.dependencies ?? []) as string[];
    if (dependencies.length > 0) {
      const seen = new Set<string>();
      let frontier = [...dependencies];
      while (frontier.length > 0) {
        for (const current of frontier) {
          if (current === taskId) {
            throw new BadRequestException('task_graph_cycle');
          }
          seen.add(current);
        }
        const rows = await this.db
          .select({ taskId: ewohAgentTask.taskId, dependencies: ewohAgentTask.dependencies })
          .from(ewohAgentTask)
          .where(and(eq(ewohAgentTask.orgId, orgId), inArray(ewohAgentTask.taskId, frontier)));
        const next = new Set<string>();
        for (const row of rows) {
          for (const dep of (row.dependencies ?? []) as string[]) {
            if (!seen.has(dep)) next.add(dep);
          }
        }
        frontier = [...next];
      }
    }
    // 并发预算 + 落库（NEST-324：advisory xact lock 串行化「检查-插入」——
    // 原先 check-then-insert 窗口内两并发 createTask 同时过预算检查超限）。
    const assignedRole = task.assignedRole as string;
    const dueTimeRaw = task.dueTime as string | undefined;
    const lockKey = `${orgId}:role:${assignedRole}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const activeRows = await tx
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
      await tx.insert(ewohAgentTask).values({
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
    actor?: AgentTaskActor,
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
    // SH-005：转移表 role 约束（orchestrator/agent）——调用方强制从
    // actor.roles 派生 actorRole 传入，不再依赖契约层缺省放行。
    const actorRole = deriveActorRole(actor);
    if (!agentTaskTransitionAllowed(row.status, target, actorRole)) {
      throw new BadRequestException(
        `actor_role_forbidden:${row.status}->${target}:${actorRole ?? 'unspecified'}`,
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
      // NEST-362：终态事件 subject 以台账行事实优先（taskJson 缺失的存量行
      // 回退最小 {taskId}——创建路径必写 taskJson，此兜底仅覆盖历史行）。
      const taskInput = ((row.taskJson ?? null) as AgentTaskInput | null) ?? {
        taskId,
        name: row.name,
        assignedRole: row.assignedRole,
      };
      await this.recordTaskEvent(orgId, taskInput, 'AgentTaskCompleted', {
        status: target,
      });
    }
    await this.auditAppend(orgId, `agent.task.${target}`, taskId, actor);
    return { taskId, status: target };
  }

  async dispatchTask(orgId: string, taskId: string, actor?: AgentTaskActor) {
    return this.transition(orgId, taskId, 'dispatched', ['created'], actor);
  }

  async startTask(orgId: string, taskId: string, actor?: AgentTaskActor) {
    return this.transition(orgId, taskId, 'in_progress', ['dispatched'], actor);
  }

  async completeTask(
    orgId: string,
    taskId: string,
    outcome: { status: 'completed' | 'failed'; outcomeJson?: Record<string, unknown> },
    actor?: AgentTaskActor,
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
      // taskJson 是任务的**完整契约记录**（createTask 写入；NEST-362 终态事件
      // 与 listTasks 读面都依赖它）。原先用 {taskId,status,outcomeJson} 整体覆盖，
      // 完成即丢失 name/kind/assignedRole/dependencies/budget 等全部契约字段。
      // 这里在既有 taskJson 上合并 outcome：原记录保留 + status 同步 + 结果附加。
      const [current] = await this.db
        .select({ taskJson: ewohAgentTask.taskJson })
        .from(ewohAgentTask)
        .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, taskId)))
        .limit(1);
      const baseTaskJson = ((current?.taskJson ?? null) as Record<string, unknown> | null) ?? {};
      await this.db
        .update(ewohAgentTask)
        .set({
          taskJson: {
            ...baseTaskJson,
            status: result.status,
            outcomeJson: outcome.outcomeJson,
          },
        })
        .where(and(eq(ewohAgentTask.orgId, orgId), eq(ewohAgentTask.taskId, taskId)));
    }
    return result;
  }

  async cancelTask(orgId: string, taskId: string, actor?: AgentTaskActor) {
    return this.transition(
      orgId,
      taskId,
      'cancelled',
      ['created', 'dispatched', 'in_progress'],
      actor,
    );
  }

  /**
   * NEST-326（2026-08-17 审计整改）：列表分页（原先无界全表）。
   * limit 缺省 100、上限 500；offset 缺省 0。
   */
  async listTasks(
    orgId: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<Record<string, unknown>[]> {
    const limit = Math.min(Math.max(1, Math.trunc(pagination?.limit ?? 100)), 500);
    const offset = Math.max(0, Math.trunc(pagination?.offset ?? 0));
    const rows = await this.db
      .select()
      .from(ewohAgentTask)
      .where(eq(ewohAgentTask.orgId, orgId))
      .orderBy(desc(ewohAgentTask.createdAt))
      .limit(limit)
      .offset(offset);
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
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
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
    actor?: AgentTaskActor,
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
