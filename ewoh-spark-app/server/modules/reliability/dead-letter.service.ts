import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohDeadLetter, ewohEvent } from '@server/database/schema';
import { validateDeadLetter } from '@shared/dead-letter';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface RecordDeadLetterInput {
  sourceId: string;
  reason: string;
  envelope: Record<string, unknown>;
  correlationId?: string | null;
}

export interface DeadLetterRequeueHandler {
  (orgId: string, envelope: Record<string, unknown>): Promise<void>;
}

/**
 * DeadLetterService（ADR-024 / NO-11a，§20 Reliability 失败终态）。
 *
 * - 永久失败消息的终态台账：record（契约校验 fail-closed）→ 幂等落账
 *   （letterId = dl:{sha256(sourceId)[:12]}:{eventId} 确定性推导，唯一键冲突
 *   回读不重复发事件）→ DeadLetterRecorded 目录事件（57 类）；
 * - 人审重放：requeue 按 sourceId 分发到注册 handler（v1：cloud:ingest →
 *   重新投递同源处理）；attempts+1 显式递增——**绝不自动重试**（§2 人审
 *   边界，自动无限重试 = 事实层噪音源）；
 * - discard 必须带非空理由（契约 + DB CHECK 双强制，§33 不静默）；
 * - 租户边界 orgId + DB 层 RLS（standalone_043）双保险。
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);
  private readonly handlers = new Map<string, DeadLetterRequeueHandler>();

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 注册重放 handler（按 sourceId；重复注册显式拒绝——重放语义唯一）。 */
  registerHandler(sourceId: string, handler: DeadLetterRequeueHandler): void {
    if (this.handlers.has(sourceId)) {
      throw new BadRequestException(`dead_letter_handler_already_registered:${sourceId}`);
    }
    this.handlers.set(sourceId, handler);
  }

  async record(input: RecordDeadLetterInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：死信落账必须带租户上下文');
    }
    const eventId = String(input.envelope?.eventId ?? '');
    const letterId = this.deriveLetterId(input.sourceId, eventId);
    const record: Record<string, unknown> = {
      letterId,
      sourceId: input.sourceId,
      reason: input.reason,
      attempts: 1,
      status: 'pending',
      envelope: input.envelope,
      correlationId: input.correlationId ?? null,
      auditTrail: true,
    };
    const errors = validateDeadLetter(record);
    if (errors.length > 0) {
      throw new BadRequestException(`死信违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      letterId,
      sourceId: input.sourceId,
      reason: input.reason,
      attempts: 1,
      status: 'pending' as const,
      envelopeJson: input.envelope,
      correlationId: input.correlationId ?? null,
      discardedReason: null,
      recordJson: record,
    };
    let inserted;
    try {
      const result = await this.db.insert(ewohDeadLetter).values(row).returning();
      inserted = result[0];
      await this.recordEvent(inserted, orgId);
    } catch (err) {
      // 幂等：同一失败消息重复上报 → 回读既有行，不重复发事件
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohDeadLetter)
        .where(and(eq(ewohDeadLetter.orgId, orgId), eq(ewohDeadLetter.letterId, letterId)))
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`死信幂等重放命中: ${letterId}`);
      return { record: this.toLetter(existing[0]), created: false };
    }
    return { record: this.toLetter(inserted), created: true };
  }

  async listLetters(orgId: string, filters?: { status?: string; sourceId?: string }) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：死信查询必须带租户上下文');
    }
    const conditions = [eq(ewohDeadLetter.orgId, orgId)];
    if (filters?.status) conditions.push(eq(ewohDeadLetter.status, filters.status));
    if (filters?.sourceId) conditions.push(eq(ewohDeadLetter.sourceId, filters.sourceId));
    const rows = await this.db
      .select()
      .from(ewohDeadLetter)
      .where(and(...conditions))
      .orderBy(desc(ewohDeadLetter.createdAt))
      .limit(500);
    return rows.map((r) => this.toLetter(r));
  }

  /** 人审重放：handler 按 sourceId 分发；attempts+1；无 handler 显式失败。 */
  async requeue(orgId: string, letterId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：死信重放必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohDeadLetter)
      .where(and(eq(ewohDeadLetter.orgId, orgId), eq(ewohDeadLetter.letterId, letterId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('dead_letter_not_found（不存在或非本租户）');
    }
    const current = rows[0];
    if (current.status !== 'pending') {
      throw new BadRequestException(`非法重放：${current.status} 状态不可 requeue（仅 pending）`);
    }
    const handler = this.handlers.get(current.sourceId);
    if (!handler) {
      throw new BadRequestException(`no_requeue_handler:${current.sourceId}`);
    }
    await handler(orgId, current.envelopeJson as Record<string, unknown>);
    const nextAttempts = current.attempts + 1;
    await this.db
      .update(ewohDeadLetter)
      .set({ status: 'requeued', attempts: nextAttempts, updatedAt: new Date() })
      .where(and(eq(ewohDeadLetter.orgId, orgId), eq(ewohDeadLetter.id, current.id)));
    return { letterId, from: current.status, to: 'requeued', attempts: nextAttempts };
  }

  /** 丢弃（人审决策留痕）：必须带非空理由（契约 + DB CHECK 双强制）。 */
  async discard(orgId: string, letterId: string, reason: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：死信丢弃必须带租户上下文');
    }
    if (!reason?.trim()) {
      throw new BadRequestException('discard 必须带非空理由（§33 不静默丢弃）');
    }
    const rows = await this.db
      .select()
      .from(ewohDeadLetter)
      .where(and(eq(ewohDeadLetter.orgId, orgId), eq(ewohDeadLetter.letterId, letterId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('dead_letter_not_found（不存在或非本租户）');
    }
    const current = rows[0];
    if (current.status === 'discarded') {
      throw new BadRequestException('already_discarded');
    }
    await this.db
      .update(ewohDeadLetter)
      .set({ status: 'discarded', discardedReason: reason.trim(), updatedAt: new Date() })
      .where(and(eq(ewohDeadLetter.orgId, orgId), eq(ewohDeadLetter.id, current.id)));
    return { letterId, from: current.status, to: 'discarded' };
  }

  /** letterId = dl:{sha256(sourceId)[:12]}:{eventId}（确定性幂等键）。 */
  private deriveLetterId(sourceId: string, eventId: string): string {
    const digest = createHash('sha256').update(sourceId).digest('hex').slice(0, 12);
    return `dl:${digest}:${eventId || 'unknown'}`;
  }

  private toLetter(row: typeof ewohDeadLetter.$inferSelect): Record<string, unknown> {
    return {
      letterId: row.letterId,
      sourceId: row.sourceId,
      reason: row.reason,
      attempts: row.attempts,
      status: row.status,
      envelope: row.envelopeJson,
      correlationId: row.correlationId,
      discardedReason: row.discardedReason,
      auditTrail: true,
    };
  }

  private async recordEvent(
    row: typeof ewohDeadLetter.$inferSelect,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'DeadLetterRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:reliability',
      subject: row.letterId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'DeadLetterRecorded',
      eventCode: 'DEAD_LETTER_RECORDED',
      severity: 'medium',
      title: `DeadLetterRecorded: ${row.reason} ${row.letterId}`,
      status: 'open',
      sourceType: 'reliability',
      orgId,
      createdAt: now,
      evidenceJson: {
        letterId: row.letterId,
        sourceId: row.sourceId,
        reason: row.reason,
        attempts: row.attempts,
        envelope: row.envelopeJson,
        correlationId: row.correlationId,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
