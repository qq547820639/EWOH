import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohOutcomeAnnotation, ewohEvent } from '@server/database/schema';
import { validateOutcomeAnnotation } from '@shared/outcome-annotation';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface CreateOutcomeAnnotationInput {
  annotationId?: string;
  targetType: string;
  targetId: string;
  outcomeKind: string;
  judgedBy: string;
  judgedAt?: string;
  measured?: Record<string, number>;
  comment?: string;
}

/**
 * OutcomeAnnotationService（ADR-034 / §10 Level 7 + §12：真值标注面）。
 *
 * - Decision→Outcome 结构化事实唯一权威写路径：create（契约 fail-closed
 *   + annotationId 幂等回读——同标注不重复落账不重复发事件）、
 *   listByTarget / listRecent（租户作用域）；
 * - measured 度量快照（缺省 = 显式不携带不猜测，§33）；judgedBy 非空
 *   （判定事实完整）；
 * - 标注面是学习回路模型腿的真值来源前置：modelAccuracy 在真实可训练
 *   模型落地前保持显式 unknown（§33 不造假）。
 */
@Injectable()
export class OutcomeAnnotationService {
  private readonly logger = new Logger(OutcomeAnnotationService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async create(input: CreateOutcomeAnnotationInput, orgId: string): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：结果标注必须带租户上下文');
    }
    const annotationId = input.annotationId?.trim() || `oa:${randomUUID()}`;
    const record: Record<string, unknown> = {
      annotationId,
      targetType: String(input.targetType ?? ''),
      targetId: input.targetId,
      outcomeKind: String(input.outcomeKind ?? ''),
      judgedBy: input.judgedBy,
      judgedAt: input.judgedAt ?? new Date().toISOString(),
      measured: input.measured,
      comment: input.comment,
      auditTrail: true,
    };
    const errors = validateOutcomeAnnotation(record);
    if (errors.length > 0) {
      throw new BadRequestException(`结果标注违反契约: ${errors.join(', ')}`);
    }
    const existing = await this.db
      .select()
      .from(ewohOutcomeAnnotation)
      .where(and(
        eq(ewohOutcomeAnnotation.orgId, orgId),
        eq(ewohOutcomeAnnotation.annotationId, annotationId),
      ))
      .limit(1);
    if (existing.length > 0) {
      this.logger.debug(`结果标注幂等命中: ${annotationId}`);
      return { annotation: this.toAnnotation(existing[0]), created: false };
    }
    const row = {
      orgId,
      annotationId,
      targetType: String(input.targetType),
      targetId: String(input.targetId),
      outcomeKind: String(input.outcomeKind),
      judgedBy: input.judgedBy,
      judgedAt: new Date(String(record.judgedAt)),
      measuredJson: (input.measured ?? null) as Record<string, number> | null,
      comment: input.comment ?? null,
      recordJson: record,
    };
    // NEST-332：并发幂等——select 后 insert 的窗口内另一并发同 ID 提交会
    // 以 23505 唯一键冲突落败，此处捕获后回读既有行（不重复发事件），
    // 不再把并发幂等误报为 500。
    let inserted;
    try {
      const result = await this.db.insert(ewohOutcomeAnnotation).values(row).returning();
      inserted = result[0];
      await this.recordEvent(inserted, orgId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohOutcomeAnnotation)
        .where(and(
          eq(ewohOutcomeAnnotation.orgId, orgId),
          eq(ewohOutcomeAnnotation.annotationId, annotationId),
        ))
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`结果标注并发幂等命中: ${annotationId}`);
      return { annotation: this.toAnnotation(existing[0]), created: false };
    }
    return { annotation: this.toAnnotation(inserted), created: true };
  }

  async listByTarget(orgId: string, targetType: string, targetId: string): Promise<unknown[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：标注查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohOutcomeAnnotation)
      .where(and(
        eq(ewohOutcomeAnnotation.orgId, orgId),
        eq(ewohOutcomeAnnotation.targetType, targetType),
        eq(ewohOutcomeAnnotation.targetId, targetId),
      ))
      .orderBy(desc(ewohOutcomeAnnotation.judgedAt))
      .limit(200);
    return rows.map((r) => this.toAnnotation(r));
  }

  async listRecent(orgId: string, filters?: { outcomeKind?: string }): Promise<unknown[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：标注查询必须带租户上下文');
    }
    const conditions = [eq(ewohOutcomeAnnotation.orgId, orgId)];
    if (filters?.outcomeKind) {
      conditions.push(eq(ewohOutcomeAnnotation.outcomeKind, filters.outcomeKind));
    }
    const rows = await this.db
      .select()
      .from(ewohOutcomeAnnotation)
      .where(and(...conditions))
      .orderBy(desc(ewohOutcomeAnnotation.judgedAt))
      .limit(500);
    return rows.map((r) => this.toAnnotation(r));
  }

  private toAnnotation(row: typeof ewohOutcomeAnnotation.$inferSelect): Record<string, unknown> {
    return {
      annotationId: row.annotationId,
      targetType: row.targetType,
      targetId: row.targetId,
      outcomeKind: row.outcomeKind,
      judgedBy: row.judgedBy,
      judgedAt: row.judgedAt.toISOString(),
      measured: row.measuredJson ?? undefined,
      comment: row.comment ?? undefined,
      auditTrail: true,
    };
  }

  private async recordEvent(
    row: typeof ewohOutcomeAnnotation.$inferSelect,
    orgId: string,
  ): Promise<void> {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'OutcomeAnnotationRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:learning',
      subject: row.annotationId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'OutcomeAnnotationRecorded',
      eventCode: 'OUTCOME_ANNOTATION_RECORDED',
      severity: 'low',
      title: `OutcomeAnnotationRecorded: ${row.targetType} ${row.targetId}`,
      status: 'open',
      sourceType: 'learning',
      orgId,
      createdAt: now,
      evidenceJson: {
        annotationId: row.annotationId,
        targetType: row.targetType,
        targetId: row.targetId,
        outcomeKind: row.outcomeKind,
        judgedBy: row.judgedBy,
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
