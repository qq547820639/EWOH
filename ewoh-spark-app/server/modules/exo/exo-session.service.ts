import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohExoSession, ewohEvent } from '@server/database/schema';
import {
  validateExoSession,
  exoSessionTransitionAllowed,
  type ExoSessionStatus,
} from '@shared/exo-session';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface StartExoSessionInput {
  sessionId?: string;
  exoId: string;
  personId: string;
  startedAt?: string;
  expectedEndAt?: string;
  operatorId?: string;
  reason?: string;
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
    const record: Record<string, unknown> = {
      sessionId,
      exoId: input.exoId,
      personId: input.personId,
      status: 'active',
      startedAt,
      expectedEndAt: input.expectedEndAt,
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
      expectedEndAt: input.expectedEndAt ? new Date(input.expectedEndAt) : null,
      actualEndAt: null,
      endedBy: null,
      reason: input.reason ?? null,
      operatorId: input.operatorId ?? null,
      recordJson: record,
    };
    const existing = await this.db
      .select()
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.sessionId, sessionId)))
      .limit(1);
    if (existing.length > 0) {
      // ADR-033 决策 3：应用层幂等（at-least-once 事件投影安全）
      return this.toSession(existing[0]);
    }
    let inserted;
    try {
      // R2-SAM-006：主事实（insert）与目录事件同事务（参照 exo-config NEST-431
      // 的 recordEventOn 模式）——事件写失败整体回滚，消除“会话已落库、
      // ExoSessionStarted 事件永久丢失（ADR-033 幂等重试命中 existing 回读，
      // 事件永不补发）”的留痕缺口。
      await this.db.transaction(async (tx) => {
        inserted = (await tx.insert(ewohExoSession).values(row).returning())[0];
        await this.recordEventOn(tx, inserted, orgId, 'ExoSessionStarted', 'active');
      });
    } catch (err) {
      // §7 机器强制：同外骨骼活跃会话冲突（23505 部分唯一索引）→ 显式冲突
      const code = (err as { code?: string }).code;
      if (code === '23505') {
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
      await this.recordEventOn(tx, rows[0], orgId, 'ExoSessionEnded', to);
      return rows[0];
    });
    return this.toSession(updated);
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

  private toSession(row: typeof ewohExoSession.$inferSelect): Record<string, unknown> {
    return {
      sessionId: row.sessionId,
      exoId: row.exoId,
      personId: row.personId,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      expectedEndAt: row.expectedEndAt ? row.expectedEndAt.toISOString() : undefined,
      actualEndAt: row.actualEndAt ? row.actualEndAt.toISOString() : undefined,
      endedBy: row.endedBy ?? undefined,
      reason: row.reason ?? undefined,
      operatorId: row.operatorId ?? undefined,
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
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
