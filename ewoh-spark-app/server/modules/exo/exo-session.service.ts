import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ewohExoSession,
  ewohEvent,
  ewohDevice,
  ewohProductionTask,
} from '@server/database/schema';
import {
  validateExoSession,
  exoSessionTransitionAllowed,
  projectExoSessionTiming,
  summarizeExoSessionDeviations,
  type ExoSessionStatus,
} from '@shared/exo-session';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
import { normalizePersonRef } from '@shared/identity';
import type { OrgContext } from '../shared/org-context.interceptor';
import {
  buildDeviceContextSuggestion,
  describeExoAssignmentConflict,
  describeExoSessionStartConflict,
  findExoAssignmentConflicts,
  findExoSessionStartConflicts,
  type ExoActiveSessionFact,
  type ExoAssignmentCandidate,
  type DeviceContextTaskFact,
} from './exo-assignment-guard';
import { TASK_LOCKED_STATUSES } from '../scheduler/task-lifecycle';
import {
  classifyExoTelemetryConsistency,
  EXO_TELEMETRY_FRESH_MS,
  type ExoTelemetryEvidence,
} from './exo-session-telemetry';
import {
  resolveSessionNotifications,
  type SessionNotificationResolution,
} from './exo-session-notification-link';

export interface StartExoSessionInput {
  sessionId?: string;
  exoId: string;
  personId: string;
  startedAt?: string;
  expectedEndAt?: string;
  operatorId?: string;
  reason?: string;
  /**
   * NO-40a：关联的业务任务 id（同租户）。绑定后：
   *   · 设备必须与该任务一致（若任务已指定设备）——不一致即显式冲突；
   *   · 未显式填写 `expectedEndAt` 时**继承任务的计划结束时间**（提升偏差可比样本率）；
   *   · 来源写入 `recordJson.expectedEndSource`（operator / task_plan_end）。
   */
  taskId?: string;
}

/**
 * ExoSessionService（ADR-032 / §7：外骨骼↔人员绑定 Session 唯一权威写路径）。
 *
 * - start：契约 fail-closed（规范身份/时间语义/auditTrail）→ 活跃冲突
 *   （同外骨骼已有 active 会话）显式 conflict（23505 → 明确异常，绝不
 *   静默双绑定——§7 机器强制 + DB 部分唯一索引双保险）→ ExoSessionStarted；
 * - end/abort：状态机 active→{ended, aborted}（终态不可复开），endedBy
 *   必填、actualEndAt 落账（结束事实完整，§33 不悬空）→ ExoSessionEnded；
 * - list/get：租户作用域（他租户会话绝不可见，§15）；DB RLS 双保险；
 * - 会话是新事实：不重开旧会话（新绑定 = 新 sessionId）。
 */
/**
 * 沿 `cause` 链提取 PostgreSQL 错误码（NO-33a 修复）。
 *
 * drizzle 的 `db.transaction(...)` 会把驱动错误包成带 `cause` 的包装错误，
 * 只看顶层 `err.code` 会漏判唯一键冲突（实测：同外骨骼第二活跃会话返回 500）。
 */
export function extractPgErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 5) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string' && candidate.code.trim() !== '') return candidate.code;
  return extractPgErrorCode(candidate.cause, depth + 1);
}

@Injectable()
export class ExoSessionService {
  private readonly logger = new Logger(ExoSessionService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async start(input: StartExoSessionInput, orgId: string): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：会话开始必须带租户上下文');
    }
    const startedAt = input.startedAt ?? new Date().toISOString();
    const sessionId = input.sessionId?.trim() || `exo-session:${randomUUID()}`;
    // NO-40a：任务绑定与"预计结束时间"的来源解析（在锁设备行之前读即可：
    // 任务绑定是**补充事实**，冲突判定仍由锁后的在飞任务检查负责）。
    const binding = await this.resolveTaskBinding(orgId, input);
    const expectedEndAt = input.expectedEndAt ?? binding.inheritedExpectedEndAt ?? undefined;
    const expectedEndSource = input.expectedEndAt
      ? 'operator'
      : binding.inheritedExpectedEndAt
        ? 'task_plan_end'
        : undefined;
    const record: Record<string, unknown> = {
      sessionId,
      exoId: input.exoId,
      personId: input.personId,
      status: 'active',
      startedAt,
      expectedEndAt,
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      ...(expectedEndSource ? { expectedEndSource } : {}),
      operatorId: input.operatorId,
      reason: input.reason,
      auditTrail: true,
    };
    const errors = validateExoSession(record);
    if (errors.length > 0) {
      throw new BadRequestException(`外骨骼会话违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      sessionId,
      exoId: input.exoId,
      personId: input.personId,
      status: 'active' as const,
      startedAt: new Date(startedAt),
      expectedEndAt: expectedEndAt ? new Date(expectedEndAt) : null,
      actualEndAt: null,
      endedBy: null,
      reason: input.reason ?? null,
      operatorId: input.operatorId ?? null,
      taskId: binding.taskId,
      recordJson: record,
    };
    const existing = await this.db
      .select()
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.sessionId, sessionId)))
      .limit(1);
    if (existing.length > 0) {
      // ADR-033 决策 3：应用层幂等（at-least-once 事件投影安全）。
      // replay 标记（2026-09-13）：终态旧会话的重放原样返回是幂等正确行为，
      // 但调用方若不检查 status 会把"重放了一条已结束的旧会话"误读成"刚激活"——
      // 显式 replay=true 让"重放"与"新建"在响应层可区分（不改变任何既有字段）。
      return { ...this.toSession(existing[0]), replay: true };
    }
    let inserted;
    try {
      // R2-SAM-006：主事实（insert）与目录事件同事务（参照 exo-config NEST-431
      // 的 recordEventOn 模式）——事件写失败整体回滚，消除“会话已落库、
      // ExoSessionStarted 事件永久丢失（ADR-033 幂等重试命中 existing 回读，
      // 事件永不补发）”的留痕缺口。
      await this.db.transaction(async (tx) => {
        // NO-39a：会话是**反方向的执行边界**——先锁住设备行（与派工/任务写入同一把锁，
        // 两个方向互斥），再检查该设备是否已被"在飞任务"指派给别人。
        // 锁必须在读之前：否则两端各读到"对方还没写"的旧状态，双写都会成功。
        await this.lockDeviceForSessionStart(tx, orgId, input.exoId);
        await this.assertNoInFlightTaskConflict(tx, orgId, input.exoId, input.personId);
        inserted = (await tx.insert(ewohExoSession).values(row).returning())[0];
        await this.recordEventOn(tx, inserted, orgId, 'ExoSessionStarted', 'active');
      });
    } catch (err) {
      // §7 机器强制：同外骨骼活跃会话冲突（23505 部分唯一索引）→ 显式冲突。
      // ⚠️ 实测（2026-09-12）：drizzle 会把驱动错误包一层（`DrizzleQueryError`），
      // 顶层没有 `code`，只查 `err.code` 会漏判 → 冲突被当成 500 抛出。
      // 因此沿 `cause` 链找 PostgreSQL 错误码。
      if (extractPgErrorCode(err) === '23505') {
        throw new BadRequestException('conflict_exo_session_active：该外骨骼已有活跃会话（先结束再开始新会话，§7）');
      }
      throw err;
    }
    return this.toSession(inserted);
  }

  async endSession(
    orgId: string,
    sessionId: string,
    endedBy: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.terminate(orgId, sessionId, 'ended', endedBy, reason);
  }

  async abortSession(
    orgId: string,
    sessionId: string,
    endedBy: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.terminate(orgId, sessionId, 'aborted', endedBy, reason);
  }

  private async terminate(
    orgId: string,
    sessionId: string,
    to: 'ended' | 'aborted',
    endedBy: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：会话结束必须带租户上下文');
    }
    if (!endedBy?.trim()) {
      throw new BadRequestException('endedBy 必填（结束事实完整，§33 不悬空）');
    }
    const current = await this.mustGet(orgId, sessionId);
    if (current.status === to) {
      // ADR-033 决策 3：重复 ended/aborted 幂等返回（不报错）
      return this.toSession(current);
    }
    if (!exoSessionTransitionAllowed(current.status, to)) {
      throw new BadRequestException(`非法会话转移：${current.status} → ${to} 不允许（终态不可复开，ADR-032）`);
    }
    const now = new Date();
    const record = {
      ...(current.recordJson as Record<string, unknown>),
      status: to,
      actualEndAt: now.toISOString(),
      endedBy: endedBy.trim(),
      reason: reason?.trim() || undefined,
    };
    // R2-SAM-005/006：终态 UPDATE 带 eq(status) CAS（两个并发 terminate——
    // end+abort——先读都见 active 时，后提交者命中 0 行，按状态冲突拒绝，
    // 绝不覆盖先提交者的终态，ADR-032 终态不可复开）；同时主事实与
    // ExoSessionEnded 事件同事务（事件失败整体回滚，无“已终结无事件”半态）。
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ewohExoSession)
        .set({
          status: to as ExoSessionStatus,
          actualEndAt: now,
          endedBy: endedBy.trim(),
          reason: reason?.trim() || current.reason,
          recordJson: record,
          updatedAt: now,
        })
        .where(
          and(
            eq(ewohExoSession.orgId, orgId),
            eq(ewohExoSession.id, current.id),
            eq(ewohExoSession.status, current.status),
          ),
        )
        .returning();
      if (rows.length === 0) {
        // 与“重复 ended/aborted 幂等返回”分支区分：并发终态改写显式冲突（fail-closed）。
        throw new BadRequestException(
          `exo_session_state_changed_concurrently:${current.status}（并发终结冲突，终态不可复开 ADR-032）`,
        );
      }
      // NO-44a：会话终态与"提醒终态"是同一件事的两面——同一事务内把该会话的
      // 待处置提醒落到 resolved（谁/何时/依据哪次处置），半成品状态不允许出现。
      const resolutions = await resolveSessionNotifications(tx, {
        orgId,
        sessionId: rows[0].sessionId,
        resolution: to === 'aborted' ? 'session_aborted' : 'session_ended',
        resolvedBy: endedBy.trim(),
        resolutionRef: rows[0].sessionId,
        now,
      });
      await this.recordEventOn(tx, rows[0], orgId, 'ExoSessionEnded', to, {
        resolvedNotificationCount: resolutions.closed,
        annotatedNotificationCount: resolutions.annotated,
        notificationResolution: to === 'aborted' ? 'session_aborted' : 'session_ended',
      });
      return { row: rows[0], resolutions };
    });
    return this.toSession(updated.row, updated.resolutions);
  }

  async listSessions(orgId: string, filters?: { status?: string; exoId?: string }) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：会话查询必须带租户上下文');
    }
    const conditions = [eq(ewohExoSession.orgId, orgId)];
    if (filters?.status) conditions.push(eq(ewohExoSession.status, filters.status));
    if (filters?.exoId) conditions.push(eq(ewohExoSession.exoId, filters.exoId));
    const rows = await this.db
      .select()
      .from(ewohExoSession)
      .where(and(...conditions))
      .orderBy(desc(ewohExoSession.startedAt))
      .limit(500);
    return rows.map((r) => this.toSession(r));
  }

  async getSession(orgId: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.toSession(await this.mustGet(orgId, sessionId));
  }

  /**
   * NO-38a：会话偏差的"经验"聚合（运行记忆 → 可判定的结论）。
   *
   * 为什么放在服务层：聚合口径是纯函数（`summarizeExoSessionDeviations`），
   * 但**取数范围**必须由服务端钉死——窗口按 `started_at` 过滤、只取已收工
   * （ended/aborted）、租户作用域、行数上限并如实标记 `truncated`。
   *
   * 诚实边界（原则 7）：
   * - 只把"已收工"的会话放进统计（进行中的会话没有"实际结束"，谈不上偏差）；
   * - 上限截断时返回 `truncated=true`，绝不让人以为"这就是全部历史"；
   * - 比率门槛与文案来自共享纯函数（低于门槛 → null + 说明）。
   */
  async summarizeDeviations(
    orgId: string,
    filters?: { windowDays?: number; groupBy?: 'device' | 'person'; limit?: number },
  ): Promise<ReturnType<typeof summarizeExoSessionDeviations>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：偏差聚合必须带租户上下文');
    }
    const windowDays =
      Number.isFinite(filters?.windowDays) && Number(filters?.windowDays) > 0
        ? Math.min(365, Math.floor(Number(filters?.windowDays)))
        : 30;
    const groupBy = filters?.groupBy === 'person' ? 'person' : 'device';
    const limit =
      Number.isFinite(filters?.limit) && Number(filters?.limit) > 0
        ? Math.min(5000, Math.floor(Number(filters?.limit)))
        : 2000;
    const since = new Date(Date.now() - windowDays * 24 * 3_600_000);
    const rows = await this.db
      .select({
        sessionId: ewohExoSession.sessionId,
        exoId: ewohExoSession.exoId,
        personId: ewohExoSession.personId,
        status: ewohExoSession.status,
        startedAt: ewohExoSession.startedAt,
        expectedEndAt: ewohExoSession.expectedEndAt,
        actualEndAt: ewohExoSession.actualEndAt,
      })
      .from(ewohExoSession)
      .where(
        and(
          eq(ewohExoSession.orgId, orgId),
          inArray(ewohExoSession.status, ['ended', 'aborted']),
          gte(ewohExoSession.startedAt, since),
        ),
      )
      .orderBy(desc(ewohExoSession.startedAt))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    const scoped = truncated ? rows.slice(0, limit) : rows;
    const summary = summarizeExoSessionDeviations(
      scoped.map((row) => ({
        sessionId: row.sessionId,
        deviceId: row.exoId?.startsWith('device:') ? row.exoId.slice('device:'.length) : row.exoId,
        personId: row.personId,
        status: row.status,
        expectedEndAt: row.expectedEndAt ? row.expectedEndAt.toISOString() : null,
        actualEndAt: row.actualEndAt ? row.actualEndAt.toISOString() : null,
      })),
      { windowDays, groupBy },
    );
    return { ...summary, truncated };
  }

  /**
   * NO-41a：活跃会话的**佩戴事实双源一致性**（会话声明 × 设备遥测）。
   *
   * 只读、租户作用域。为每条活跃会话取该设备"最近一帧遥测"（`DISTINCT ON (device_id)`，
   * 走 `(org_id, device_id, ts DESC)` 索引），交给纯函数判定：
   * 一致 / 佩戴人不符 / 仅证明有人在用 / 疑似未佩戴 / 证据过期 / 无遥测。
   *
   * 边界（原则 7）：缺遥测 = **无佐证**（不是"未佩戴"）；证据过期不下结论；
   * 只有"帧里写明的佩戴人 ≠ 会话佩戴者"才是硬冲突，且必须由人核实。
   */
  async listTelemetryConsistency(orgId: string): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：佩戴一致性校验必须带租户上下文');
    }
    const sessions = await this.db
      .select({
        sessionId: ewohExoSession.sessionId,
        exoId: ewohExoSession.exoId,
        personId: ewohExoSession.personId,
        startedAt: ewohExoSession.startedAt,
        expectedEndAt: ewohExoSession.expectedEndAt,
        taskId: ewohExoSession.taskId,
      })
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.status, 'active')))
      .orderBy(desc(ewohExoSession.startedAt));

    const businessIds = [...new Set(
      sessions
        .map((row) => (row.exoId?.startsWith('device:') ? row.exoId.slice('device:'.length).trim() : ''))
        .filter((id) => id !== ''),
    )];
    // 最近一帧：DISTINCT ON 按 (device_id) 取 ts 最大者（一次查询，不用 N 次往返）。
    const latestRows = businessIds.length
      ? ((await this.db.execute(sql`
          SELECT DISTINCT ON (device_id)
            device_id, ts, worker_id, load_score, assist_level, angular_velocity_dps, source_type, data_quality
          FROM ewoh_telemetry
          WHERE org_id = ${orgId} AND device_id IN (${sql.join(businessIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY device_id, ts DESC
        `)) as unknown as Array<{
          device_id?: string | null;
          ts?: Date | string | null;
          worker_id?: string | null;
          load_score?: number | null;
          assist_level?: number | null;
          angular_velocity_dps?: number | null;
          source_type?: string | null;
          data_quality?: string | null;
        }>)
      : [];
    const latestByDevice = new Map<string, ExoTelemetryEvidence>();
    for (const row of latestRows) {
      const deviceId = String(row.device_id ?? '').trim();
      if (!deviceId) continue;
      const ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts ?? '');
      latestByDevice.set(deviceId, {
        ts,
        workerId: row.worker_id == null ? null : String(row.worker_id),
        loadScore: typeof row.load_score === 'number' ? row.load_score : null,
        assistLevel: typeof row.assist_level === 'number' ? row.assist_level : null,
        angularVelocityDps: typeof row.angular_velocity_dps === 'number' ? row.angular_velocity_dps : null,
        sourceType: row.source_type == null ? null : String(row.source_type),
        dataQuality: row.data_quality == null ? null : String(row.data_quality),
      });
    }

    const now = new Date();
    const summary: Record<string, number> = {};
    const items = sessions.map((row) => {
      const businessId = row.exoId?.startsWith('device:') ? row.exoId.slice('device:'.length).trim() : '';
      const evidence = businessId ? latestByDevice.get(businessId) ?? null : null;
      const verdict = classifyExoTelemetryConsistency(
        { session: { sessionId: row.sessionId, personId: row.personId, exoId: row.exoId }, evidence },
        { nowMs: now.getTime() },
      );
      summary[verdict.verdict] = (summary[verdict.verdict] ?? 0) + 1;
      return {
        sessionId: row.sessionId,
        exoId: row.exoId,
        personId: row.personId,
        startedAt: row.startedAt.toISOString(),
        expectedEndAt: row.expectedEndAt ? row.expectedEndAt.toISOString() : null,
        taskId: row.taskId ?? null,
        ...verdict,
      };
    });

    return {
      generatedAt: now.toISOString(),
      freshWindowMs: EXO_TELEMETRY_FRESH_MS,
      scanned: sessions.length,
      summary,
      sessions: items,
      notes: [
        '会话是人工声明，遥测是设备证据：两源不一致必须由人核实，平台不替任何一方下结论。',
        '缺遥测 = 无佐证（不是"没有佩戴"）；遥测帧未上报佩戴人时，只能证明"有人在用"（或疑似无人使用）。',
      ],
    };
  }

  /**
   * NO-40a：会话开始的**设备上下文**（页面据此决定绑定哪张任务、继承什么计划）。
   *
   * 只读、租户作用域，返回的都是事实 + 一条"可执行建议"（不替现场做选择）：
   *   · `registered`：设备是否在台账（不在台账 = 无法被任务引用，也不会有在飞任务）；
   *   · `activeSession`：当前是否已被别人戴着（NO-34a 的硬约束，页面先提示）；
   *   · `inFlightTasks`：该设备已下发/执行中的任务（NO-39a 的边界事实）；
   *   · `suggestion`：由纯函数 `buildDeviceContextSuggestion` 推出（唯一任务才建议绑定，
   *     多任务不给建议；计划结束时间已过期则不继承）。
   */
  async getDeviceContext(
    orgId: string,
    exoId: string,
    personId?: string | null,
  ): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：设备上下文查询必须带租户上下文');
    }
    if (!exoId?.trim()) {
      throw new BadRequestException('exoId 必填（规范身份 device:<业务设备号>）');
    }
    const businessId = exoId.startsWith('device:') ? exoId.slice('device:'.length).trim() : '';
    const devices = businessId
      ? await this.db
          .select({ id: ewohDevice.id, deviceId: ewohDevice.deviceId, online: ewohDevice.online })
          .from(ewohDevice)
          .where(
            and(
              eq(ewohDevice.deviceId, businessId),
              or(isNull(ewohDevice.orgId), eq(ewohDevice.orgId, orgId)),
            ),
          )
          .limit(1)
      : [];
    const device = devices[0];
    const deviceUuid = device?.id ? String(device.id) : null;

    const activeRows = await this.db
      .select({
        sessionId: ewohExoSession.sessionId,
        personId: ewohExoSession.personId,
        startedAt: ewohExoSession.startedAt,
        expectedEndAt: ewohExoSession.expectedEndAt,
      })
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.exoId, exoId), eq(ewohExoSession.status, 'active')))
      .limit(1);
    const active = activeRows[0];

    const inFlightTasks: DeviceContextTaskFact[] = deviceUuid
      ? (
          await this.db
            .select({
              taskId: ewohProductionTask.id,
              title: ewohProductionTask.title,
              status: ewohProductionTask.status,
              assigneeId: ewohProductionTask.assigneeId,
              planEnd: ewohProductionTask.planEnd,
            })
            .from(ewohProductionTask)
            .where(
              and(
                eq(ewohProductionTask.orgId, orgId),
                eq(ewohProductionTask.deviceId, deviceUuid),
                inArray(ewohProductionTask.status, [...TASK_LOCKED_STATUSES]),
              ),
            )
        ).map((task) => ({
          taskId: String(task.taskId),
          title: task.title ?? null,
          status: String(task.status),
          assigneeId: task.assigneeId ?? null,
          planEnd: task.planEnd ? task.planEnd.toISOString() : null,
        }))
      : [];

    return {
      exoId,
      deviceUuid,
      registered: Boolean(device),
      online: device?.online ?? null,
      activeSession: active
        ? {
            sessionId: active.sessionId,
            personId: active.personId,
            startedAt: active.startedAt.toISOString(),
            expectedEndAt: active.expectedEndAt ? active.expectedEndAt.toISOString() : null,
          }
        : null,
      inFlightTasks,
      suggestion: buildDeviceContextSuggestion(inFlightTasks, { personId: personId ?? null }),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * NO-40a：解析会话与任务的绑定关系（可空），并给出可继承的预计结束时间。
   *
   * 语义（fail-closed，但**只对显式声明负责**）：
   *   · 未传 taskId → 不关联任务（合法：临时试用/演示会话），无可继承的计划时间；
   *   · 传了 taskId 但任务不存在/不属于本租户 → 400（不猜、不静默忽略用户的声明）；
   *   · 任务的设备与会话设备不一致 → 409（任务 A 的设备装到设备 B 的会话上是错的关联）；
   *   · 任务计划结束时间存在且**晚于会话开始** → 继承为 expectedEndAt；
   *     已过期/缺失的计划时间**不继承**（拿一个过去的计划当"预计结束"只会污染偏差统计）。
   *
   * 返回值只描述事实（taskId / inheritedExpectedEndAt），不写库；写库在 start 的事务里。
   */
  private async resolveTaskBinding(
    orgId: string,
    input: StartExoSessionInput,
  ): Promise<{ taskId: string | null; inheritedExpectedEndAt: string | null }> {
    const taskId = input.taskId?.trim() ?? '';
    if (!taskId) return { taskId: null, inheritedExpectedEndAt: null };
    const rows = await this.db
      .select({
        id: ewohProductionTask.id,
        title: ewohProductionTask.title,
        status: ewohProductionTask.status,
        deviceId: ewohProductionTask.deviceId,
        planEnd: ewohProductionTask.planEnd,
      })
      .from(ewohProductionTask)
      .where(and(eq(ewohProductionTask.orgId, orgId), eq(ewohProductionTask.id, taskId)))
      .limit(1);
    const task = rows[0];
    if (!task) {
      throw new BadRequestException(`task_not_found：任务 ${taskId} 不存在或不属于当前租户`);
    }
    // 设备一致性：任务若已指定设备，必须与会话设备是同一台（业务设备号 ↔ uuid）。
    const businessId = input.exoId?.startsWith('device:') ? input.exoId.slice('device:'.length).trim() : '';
    if (task.deviceId && businessId) {
      const devices = await this.db
        .select({ id: ewohDevice.id })
        .from(ewohDevice)
        .where(
          and(
            eq(ewohDevice.deviceId, businessId),
            or(isNull(ewohDevice.orgId), eq(ewohDevice.orgId, orgId)),
          ),
        )
        .limit(1);
      const deviceUuid = devices[0]?.id ? String(devices[0].id) : '';
      if (deviceUuid && String(task.deviceId) !== deviceUuid) {
        throw new ConflictException(
          `EXO_SESSION_TASK_DEVICE_MISMATCH：任务 ${taskId}（${task.title ?? '未命名'}）关联的是另一台设备，`
          + '不能把本次佩戴记到该任务上；请选择与该设备一致的任务，或不绑定任务',
        );
      }
    }
    const startedMs = Date.parse(input.startedAt ?? new Date().toISOString());
    const planEndMs = task.planEnd ? task.planEnd.getTime() : null;
    const inheritedExpectedEndAt =
      planEndMs !== null && Number.isFinite(planEndMs) && Number.isFinite(startedMs) && planEndMs > startedMs
        ? new Date(planEndMs).toISOString()
        : null;
    return { taskId, inheritedExpectedEndAt };
  }

  /**
   * NO-43a：**按实际佩戴人更正会话**（遥测冲突的一步处置）。
   *
   * 为什么做成一个服务端动作而不是让前端"先结束再开始"：两步非原子会留下
   * "旧会话已结束、新会话没开起来"的半成品状态，而现场看到的只是"设备没人戴了"——
   * 这既是数据缺口也是安全缺口。这里在**同一事务**内完成：
   *   结束旧会话（写明理由与依据）→ 锁设备行 → 复查在飞任务边界 → 以新佩戴人开始新会话
   *   → 两条目录事件同事务写入。任何一步失败整体回滚，不会留下半成品。
   *
   * 语义与边界：
   *   · 只对 `active` 会话操作（终态 → 409 `EXO_SESSION_NOT_ACTIVE`）；
   *   · 新佩戴人与当前佩戴人相同 → 400 `EXO_SESSION_WEARER_UNCHANGED`（没有要更正的事实）；
   *   · 新佩戴人仍要满足执行边界（NO-39a）：设备被在飞任务指派给别人 → 409；
   *   · 新会话继承旧会话的关联任务，并按任务计划结束时间（若仍在未来）继承预计结束；
   *   · 更正来源写进新会话的 `recordJson.correctedFrom`（可追溯"这次更正从哪来"）。
   */
  async correctWearer(
    orgId: string,
    sessionId: string,
    input: { personId: string; endedBy?: string; reason?: string },
    actor?: OrgContext,
  ): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：会话更正必须带租户上下文');
    }
    const current = await this.mustGet(orgId, sessionId);
    if (current.status !== 'active') {
      throw new ConflictException(
        `EXO_SESSION_NOT_ACTIVE：会话 ${sessionId} 当前状态为 ${current.status}，只有进行中的会话才能更正佩戴人`,
      );
    }
    // 规范身份：允许调用方传裸人员 id（页面/脚本常见形态），统一补 `person:` 前缀。
    const rawWearer = String(input?.personId ?? '').trim();
    const wearerRef = normalizePersonRef(rawWearer);
    if (!wearerRef) {
      throw new BadRequestException('personId 必填：更正佩戴人必须给出人员 id');
    }
    const nextPersonId = rawWearer.startsWith('person:') ? rawWearer : `person:${wearerRef}`;
    const currentRef = normalizePersonRef(current.personId);
    if (currentRef === wearerRef) {
      throw new BadRequestException(
        `EXO_SESSION_WEARER_UNCHANGED：会话 ${sessionId} 的佩戴人已经是 ${wearerRef}，无需更正`,
      );
    }
    const endedBy = (input?.endedBy ?? actor?.userId ?? '').trim();
    if (!endedBy) {
      throw new BadRequestException('endedBy 必填（更正会结束旧会话，结束事实必须完整）');
    }
    const reason =
      (input?.reason ?? '').trim()
      || `遥测校验：按实际佩戴人更正（${currentRef ?? '未记录'} → ${wearerRef}）`;
    const now = new Date();
    const newSessionId = `exo-session:${randomUUID()}`;

    const result = await this.db.transaction(async (tx) => {
      // 1) 结束旧会话（CAS：仅当仍为 active，避免与并发终结竞争）。
      const oldRecord = {
        ...(current.recordJson as Record<string, unknown>),
        status: 'ended',
        actualEndAt: now.toISOString(),
        endedBy,
        reason,
        correctedTo: newSessionId,
      };
      const endedRows = await tx
        .update(ewohExoSession)
        .set({
          status: 'ended' as ExoSessionStatus,
          actualEndAt: now,
          endedBy,
          reason,
          recordJson: oldRecord,
          updatedAt: now,
        })
        .where(
          and(
            eq(ewohExoSession.orgId, orgId),
            eq(ewohExoSession.id, current.id),
            eq(ewohExoSession.status, 'active'),
          ),
        )
        .returning();
      if (endedRows.length === 0) {
        throw new ConflictException(
          `EXO_SESSION_NOT_ACTIVE：会话 ${sessionId} 在更正过程中被并发终结，本次更正未生效（请刷新后重试）`,
        );
      }
      // NO-44a：更正=旧会话的提醒随之了结（`resolutionRef` 指向新会话，可反查这次交接）。
      const resolutions = await resolveSessionNotifications(tx, {
        orgId,
        sessionId: endedRows[0].sessionId,
        resolution: 'session_corrected',
        resolvedBy: endedBy,
        resolutionRef: newSessionId,
        now,
      });
      await this.recordEventOn(tx, endedRows[0], orgId, 'ExoSessionEnded', 'ended', {
        resolvedNotificationCount: resolutions.closed,
        annotatedNotificationCount: resolutions.annotated,
        notificationResolution: 'session_corrected',
        notificationResolutionRef: newSessionId,
      });

      // 2) 锁设备行 + 复查在飞任务边界（新佩戴人同样受执行边界约束）。
      await this.lockDeviceForSessionStart(tx, orgId, current.exoId);
      await this.assertNoInFlightTaskConflict(tx, orgId, current.exoId, nextPersonId);

      // 3) 以新佩戴人开始新会话：继承任务与（仍在未来的）计划结束时间。
      let inheritedExpectedEndAt: string | null = null;
      if (current.taskId) {
        const binding = await this.resolveTaskBinding(orgId, {
          exoId: current.exoId,
          personId: nextPersonId,
          taskId: current.taskId,
          startedAt: now.toISOString(),
        });
        inheritedExpectedEndAt = binding.inheritedExpectedEndAt;
      }
      const record: Record<string, unknown> = {
        sessionId: newSessionId,
        exoId: current.exoId,
        personId: nextPersonId,
        status: 'active',
        startedAt: now.toISOString(),
        ...(inheritedExpectedEndAt ? { expectedEndAt: inheritedExpectedEndAt } : {}),
        ...(inheritedExpectedEndAt ? { expectedEndSource: 'task_plan_end' } : {}),
        ...(current.taskId ? { taskId: current.taskId } : {}),
        correctedFrom: sessionId,
        correctionReason: reason,
        operatorId: actor?.userId ?? undefined,
        auditTrail: true,
      };
      const errors = validateExoSession(record);
      if (errors.length > 0) {
        throw new BadRequestException(`外骨骼会话违反契约: ${errors.join(', ')}`);
      }
      const [inserted] = await tx
        .insert(ewohExoSession)
        .values({
          orgId,
          sessionId: newSessionId,
          exoId: current.exoId,
          personId: nextPersonId,
          status: 'active' as const,
          startedAt: now,
          expectedEndAt: inheritedExpectedEndAt ? new Date(inheritedExpectedEndAt) : null,
          actualEndAt: null,
          endedBy: null,
          reason: null,
          operatorId: actor?.userId ?? null,
          taskId: current.taskId ?? null,
          recordJson: record,
        })
        .returning();
      await this.recordEventOn(tx, inserted, orgId, 'ExoSessionStarted', 'active', {
        correctedFrom: sessionId,
      });
      return { ended: endedRows[0], started: inserted, resolutions };
    });

    return {
      corrected: true,
      fromPersonId: current.personId,
      toPersonId: nextPersonId,
      reason,
      // 旧会话带上"随之关闭了几条提醒"；新会话没有处置副作用（它是被开启的一方）。
      ended: this.toSession(result.ended, result.resolutions),
      started: this.toSession(result.started),
      resolvedNotificationCount: result.resolutions.closed,
      annotatedNotificationCount: result.resolutions.annotated,
    };
  }

  /**
   * NO-39a：锁住"业务设备号"对应的台账设备行（`FOR UPDATE`）。
   *
   * 为什么锁设备行：本方法与派工事务（`dispatch-coordinator` 的设备行锁）互斥，
   * 于是"派工给 A"与"B 开始会话"两个事务被串行化——先提交者的写入会被后者的
   * 检查读到，绝不会出现"A 的任务已下发 + B 正在佩戴"这种物理上不可能的状态。
   *
   * 设备不在台账（例如 e2e 用的临时设备号）→ 无行可锁、也无法被任务引用，
   * 此时不做任何判定（不猜、也不阻塞）。
   */
  private async lockDeviceForSessionStart(
    tx: Pick<PostgresJsDatabase, 'select'>,
    orgId: string,
    exoId: string,
  ): Promise<void> {
    const businessId = exoId?.startsWith('device:') ? exoId.slice('device:'.length).trim() : '';
    if (!businessId) return;
    await tx
      .select({ id: ewohDevice.id })
      .from(ewohDevice)
      .where(
        and(
          eq(ewohDevice.deviceId, businessId),
          or(isNull(ewohDevice.orgId), eq(ewohDevice.orgId, orgId)),
        ),
      )
      .for('update');
  }

  /**
   * NO-39a：开始会话前检查"该设备是否已被在飞任务指派给别人"（fail-closed）。
   *
   * 与 NO-36a 对称：派工查会话、会话查派工；只有两端都成立，
   * "这台外骨骼此刻归谁用"才是唯一确定的。冲突 → 409 `EXO_SESSION_TASK_CONFLICT`，
   * 消息里给出任务、受派人、佩戴者与解决方向。
   */
  private async assertNoInFlightTaskConflict(
    tx: Pick<PostgresJsDatabase, 'select'>,
    orgId: string,
    exoId: string,
    wearerPersonId: string,
  ): Promise<void> {
    const businessId = exoId?.startsWith('device:') ? exoId.slice('device:'.length).trim() : '';
    if (!businessId) return;
    const devices = await tx
      .select({ id: ewohDevice.id })
      .from(ewohDevice)
      .where(
        and(
          eq(ewohDevice.deviceId, businessId),
          or(isNull(ewohDevice.orgId), eq(ewohDevice.orgId, orgId)),
        ),
      );
    const deviceUuid = devices[0]?.id ? String(devices[0].id) : '';
    if (!deviceUuid) return;
    const tasks = await tx
      .select({
        taskId: ewohProductionTask.id,
        title: ewohProductionTask.title,
        status: ewohProductionTask.status,
        assigneeId: ewohProductionTask.assigneeId,
        deviceId: ewohProductionTask.deviceId,
      })
      .from(ewohProductionTask)
      .where(
        and(
          eq(ewohProductionTask.orgId, orgId),
          eq(ewohProductionTask.deviceId, deviceUuid),
          inArray(ewohProductionTask.status, [...TASK_LOCKED_STATUSES]),
        ),
      );
    const conflicts = findExoSessionStartConflicts(
      tasks.map((task) => ({
        taskId: String(task.taskId),
        title: task.title ?? null,
        status: String(task.status),
        deviceUuid: String(task.deviceId),
        assigneeId: task.assigneeId ?? null,
      })),
      { deviceUuid, wearerPersonId },
    );
    if (conflicts.length === 0) return;
    const head = conflicts.slice(0, 3).map(describeExoSessionStartConflict);
    const more = conflicts.length > head.length ? `（另有 ${conflicts.length - head.length} 项同类冲突）` : '';
    throw new ConflictException(`EXO_SESSION_TASK_CONFLICT：${head.join('；')}${more}`);
  }

  /**
   * NO-36a：读取指定设备（调度主键 uuid）的**活跃会话权威事实**。
   *
   * 为什么直读会话表 + 设备表而不复用世界模型快照：这是"提交时刻"的硬约束判定
   * （派工事务 / 任务指派写入），必须用最权威、最即时的绑定事实；快照是给候选池和
   * 人看的预检（可能滞后数秒）。两者的判定口径由 `findExoAssignmentConflicts`
   * 统一，避免"预检说行、提交说不行"的分叉。
   *
   * 只读、租户作用域、无副作用；设备号缺口（`device_id` 为空/无对应行）时不会
   * 凭空造事实——查不到活跃会话就是"无冲突"，查到的会话一定带真实佩戴者。
   */
  async findActiveSessionsForDevices(
    orgId: string,
    deviceUuids: readonly string[],
    executor: Pick<PostgresJsDatabase, 'select'> = this.db,
  ): Promise<ExoActiveSessionFact[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：会话查询必须带租户上下文');
    }
    const ids = [...new Set(deviceUuids.map((id) => String(id ?? '').trim()).filter((id) => id !== ''))];
    if (ids.length === 0) return [];
    const rows = await executor
      .select({
        sessionId: ewohExoSession.sessionId,
        personId: ewohExoSession.personId,
        deviceUuid: ewohDevice.id,
        businessDeviceId: ewohDevice.deviceId,
      })
      .from(ewohExoSession)
      .innerJoin(ewohDevice, eq(ewohExoSession.exoId, sql`'device:' || ${ewohDevice.deviceId}`))
      .where(
        and(
          eq(ewohExoSession.orgId, orgId),
          eq(ewohExoSession.status, 'active'),
          inArray(ewohDevice.id, ids),
        ),
      );
    return rows.map((row) => ({
      sessionId: row.sessionId,
      deviceUuid: String(row.deviceUuid),
      businessDeviceId: row.businessDeviceId ?? null,
      wearerPersonId: row.personId,
    }));
  }

  /**
   * NO-36a：断言这批指派与"佩戴中"事实不冲突；冲突即抛 409（fail-closed）。
   *
   * 调用点：方案派工（事务内复查 + 事务前 fail-fast）、任务创建/指派写入。
   * 错误码 `EXO_SESSION_ASSIGNMENT_CONFLICT`（HTTP 409）——现场看到的是
   * "哪台设备、谁在戴、为什么不行、怎么解决"，而不是一句"派工失败"。
   */
  async assertAssignmentsAllowed(
    orgId: string,
    assignments: readonly ExoAssignmentCandidate[],
    executor: Pick<PostgresJsDatabase, 'select'> = this.db,
    errorCode = 'EXO_SESSION_ASSIGNMENT_CONFLICT',
  ): Promise<void> {
    const deviceIds = assignments.map((a) => String(a?.deviceId ?? '').trim()).filter((id) => id !== '');
    if (deviceIds.length === 0) return;
    const facts = await this.findActiveSessionsForDevices(orgId, deviceIds, executor);
    const conflicts = findExoAssignmentConflicts(assignments, facts);
    if (conflicts.length === 0) return;
    const head = conflicts.slice(0, 3).map(describeExoAssignmentConflict);
    const more = conflicts.length > head.length ? `（另有 ${conflicts.length - head.length} 项同类冲突）` : '';
    throw new ConflictException(`${errorCode}：${head.join('；')}${more}`);
  }

  private async mustGet(orgId: string, sessionId: string) {
    const rows = await this.db
      .select()
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.sessionId, sessionId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('exo_session_not_found（不存在或非本租户）');
    }
    return rows[0];
  }

  private toSession(
    row: typeof ewohExoSession.$inferSelect,
    /**
     * NO-44a：本次处置**顺带关闭**的提醒（派生副作用）。
     * 只在"刚刚发生处置"的响应里给出：读列表/读详情时给 0 会让人误以为
     * "这次没有关闭任何提醒"，所以缺省=不返回该字段（缺失 ≠ 0，原则 7）。
     */
    dispositions?: SessionNotificationResolution,
  ): Record<string, unknown> {
    const startedAt = row.startedAt.toISOString();
    const expectedEndAt = row.expectedEndAt ? row.expectedEndAt.toISOString() : undefined;
    const actualEndAt = row.actualEndAt ? row.actualEndAt.toISOString() : undefined;
    // NO-36b：预计 vs 实际（运行记忆）——服务端算好，前端与审计/学习消费同一口径。
    const timing = projectExoSessionTiming({
      status: row.status,
      startedAt,
      expectedEndAt: expectedEndAt ?? null,
      actualEndAt: actualEndAt ?? null,
    });
    const recordJson = (row.recordJson ?? {}) as Record<string, unknown>;
    const expectedEndSource =
      recordJson.expectedEndSource === 'operator' || recordJson.expectedEndSource === 'task_plan_end'
        ? recordJson.expectedEndSource
        : undefined;
    // NO-43a：佩戴人更正链路的两个指针必须**透出**（否则审计只能看到两段互不相关的
    // 会话：一条 ended、一条 active，无法回答"这次更正对应哪条新会话"）。
    const correctedTo =
      typeof recordJson.correctedTo === 'string' && recordJson.correctedTo.trim() !== ''
        ? recordJson.correctedTo.trim()
        : undefined;
    const correctedFrom =
      typeof recordJson.correctedFrom === 'string' && recordJson.correctedFrom.trim() !== ''
        ? recordJson.correctedFrom.trim()
        : undefined;
    return {
      sessionId: row.sessionId,
      exoId: row.exoId,
      personId: row.personId,
      // NO-40a：关联任务（NULL → 不返回该字段 = 未关联，而不是"没有任务"）
      ...(row.taskId ? { taskId: row.taskId } : {}),
      expectedEndSource,
      // NO-43a：更正去向 / 更正来源（未经过更正 → 不返回该字段）
      ...(correctedTo ? { correctedTo } : {}),
      ...(correctedFrom ? { correctedFrom } : {}),
      status: row.status,
      startedAt,
      expectedEndAt,
      actualEndAt,
      endedBy: row.endedBy ?? undefined,
      reason: row.reason ?? undefined,
      operatorId: row.operatorId ?? undefined,
      timing,
      // NO-44a：处置副作用（仅在处置响应里出现）
      ...(dispositions
        ? {
            resolvedNotificationCount: dispositions.closed,
            annotatedNotificationCount: dispositions.annotated,
          }
        : {}),
      auditTrail: true,
    };
  }

  /**
   * R2-SAM-006：事件写入与主事实同事务执行（executor=db 或事务句柄，
   * 参照 exo-config recordEventOn / NEST-431 模式）。事件失败 → 事务回滚。
   */
  private async recordEventOn(
    executor: Pick<PostgresJsDatabase, 'insert'>,
    row: typeof ewohExoSession.$inferSelect,
    orgId: string,
    eventType: 'ExoSessionStarted' | 'ExoSessionEnded',
    terminalStatus: string,
    /** NO-44a：处置副作用（关闭了几条提醒）——写进事件证据，审计可查。 */
    extraEvidence?: Record<string, unknown>,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType,
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:exo-session',
      subject: row.sessionId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    // NO-36b：结束事件带上"预计 vs 实际"事实（工厂运行记忆：预测—执行—实际结果），
    // 使偏差可被复盘/学习消费，而不是只存在于一行会被覆盖的会话记录里。
    const timing = projectExoSessionTiming({
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      expectedEndAt: row.expectedEndAt ? row.expectedEndAt.toISOString() : null,
      actualEndAt: row.actualEndAt ? row.actualEndAt.toISOString() : null,
    });
    await executor.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'ExoSessionStarted' ? 'EXO_SESSION_STARTED' : 'EXO_SESSION_ENDED',
      severity: 'low',
      title: `${eventType}: ${row.sessionId}`,
      status: 'open',
      sourceType: 'exo-session',
      orgId,
      createdAt: now,
      
      // ADR-009 / standalone_066: Event Envelope

      occurredAt: now,

      // ADR-009 / standalone_066: Event Envelope

      receivedAt: now,

      // ADR-009 / standalone_066: Event Envelope

      schemaVersion: '1.0.0',

      // ADR-009 / standalone_066: Event Envelope

      correlationId: null,

      // ADR-009 / standalone_066: Event Envelope

      causationId: null,

      // ADR-009 / standalone_066: Event Envelope

      confidence: null,
evidenceJson: {
        sessionId: row.sessionId,
        exoId: row.exoId,
        personId: row.personId,
        status: terminalStatus,
        expectedEndAt: row.expectedEndAt ? row.expectedEndAt.toISOString() : null,
        actualEndAt: row.actualEndAt ? row.actualEndAt.toISOString() : null,
        durationMs: timing.durationMs,
        deviationMs: timing.deviationMs,
        deviationState: timing.deviationState,
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
        ...(extraEvidence ?? {}),
      },
    });
  }
}
