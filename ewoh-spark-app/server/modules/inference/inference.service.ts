import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohInferenceResult, ewohEvent } from '@server/database/schema';
import { validateInferenceResult } from '@shared/inference-result';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface RecordInferenceResultInput {
  inferenceId?: string | null;
  subjectId: string;
  level: string;
  modelId: string;
  modelVersion: string;
  inputVersion: string;
  label: string;
  confidence: number;
  oodIndicator: { flag: boolean; reasons: string[] };
  dataQuality: string;
  evidence: { tsStart: string; tsEnd: string; isRule: boolean };
}

/**
 * InferenceResult 服务（ADR-019 / NO-08a）：云侧模型结果历史的唯一权威写路径。
 *
 * - 契约校验 fail-closed（shared/inference-result.ts validateInferenceResult，
 *   与边缘 Python 同向量）；inferenceId 缺省 EWOH 内部生成；
 * - 创建幂等：唯一 (org_id, inference_id) 冲突 → 返回既有行，不重复发事件；
 * - 事件：创建 → InferenceResultRecorded（Canonical Catalog 信封，55 类，
 *   evidenceJson 落库，审计同源）；
 * - 租户边界 orgId + DB 层 RLS（standalone_040 inference_result_org_isolation）
 *   双保险；本台账是 Phase 12 Learning Loop 的模型结果事实层（Model
 *   Accuracy / 决策效果评估的输入）。
 */
@Injectable()
export class InferenceResultService {
  private readonly logger = new Logger(InferenceResultService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async recordInferenceResult(input: RecordInferenceResultInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：推理结果落账必须带租户上下文');
    }
    const inferenceId = input.inferenceId && input.inferenceId !== ''
      ? input.inferenceId
      : `inf-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const record: Record<string, unknown> = {
      inferenceId,
      subjectId: input.subjectId,
      level: input.level,
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      inputVersion: input.inputVersion,
      label: input.label,
      confidence: input.confidence,
      oodIndicator: input.oodIndicator,
      dataQuality: input.dataQuality,
      evidence: input.evidence,
    };
    const errors = validateInferenceResult(record);
    if (errors.length > 0) {
      throw new BadRequestException(`推理结果违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      inferenceId,
      subjectId: input.subjectId,
      level: input.level,
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      inputVersion: input.inputVersion,
      label: input.label,
      confidence: input.confidence,
      oodFlag: input.oodIndicator.flag,
      oodReasons: input.oodIndicator.reasons,
      dataQuality: input.dataQuality,
      evidenceTsStart: new Date(input.evidence.tsStart),
      evidenceTsEnd: new Date(input.evidence.tsEnd),
      evidenceIsRule: input.evidence.isRule,
      resultJson: record,
    };
    let inserted;
    try {
      const result = await this.db.insert(ewohInferenceResult).values(row).returning();
      inserted = result[0];
      await this.recordEvent(inserted, orgId);
    } catch (err) {
      // 幂等重放：唯一 (org_id, inference_id) 冲突 → 返回既有行，不重复发事件
      // （绝不静默吞其他异常——非 23505 一律重抛）。
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohInferenceResult)
        .where(
          and(
            eq(ewohInferenceResult.orgId, orgId),
            eq(ewohInferenceResult.inferenceId, inferenceId),
          ),
        )
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`推理结果幂等重放命中: ${inferenceId}`);
      return { record: this.toResult(existing[0]), created: false };
    }
    return { record: this.toResult(inserted), created: true };
  }

  async listInferenceResults(
    orgId: string,
    filters?: { level?: string; subjectId?: string },
  ) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：推理结果查询必须带租户上下文');
    }
    const conditions = [eq(ewohInferenceResult.orgId, orgId)];
    if (filters?.level) conditions.push(eq(ewohInferenceResult.level, filters.level));
    if (filters?.subjectId) {
      conditions.push(eq(ewohInferenceResult.subjectId, filters.subjectId));
    }
    const rows = await this.db
      .select()
      .from(ewohInferenceResult)
      .where(and(...conditions))
      .orderBy(desc(ewohInferenceResult.createdAt))
      .limit(500);
    return rows.map((r) => this.toResult(r));
  }

  async getInferenceResult(
    orgId: string,
    inferenceId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：推理结果查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohInferenceResult)
      .where(
        and(
          eq(ewohInferenceResult.orgId, orgId),
          eq(ewohInferenceResult.inferenceId, inferenceId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return this.toResult(rows[0]);
  }

  private toResult(row: typeof ewohInferenceResult.$inferSelect): Record<string, unknown> {
    return {
      inferenceId: row.inferenceId,
      subjectId: row.subjectId,
      level: row.level,
      modelId: row.modelId,
      modelVersion: row.modelVersion,
      inputVersion: row.inputVersion,
      label: row.label,
      confidence: row.confidence,
      oodIndicator: { flag: row.oodFlag, reasons: row.oodReasons },
      dataQuality: row.dataQuality,
      evidence: {
        tsStart: row.evidenceTsStart.toISOString(),
        tsEnd: row.evidenceTsEnd.toISOString(),
        isRule: row.evidenceIsRule,
      },
    };
  }

  private async recordEvent(
    row: typeof ewohInferenceResult.$inferSelect,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'InferenceResultRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:inference',
      subject: row.inferenceId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'InferenceResultRecorded',
      eventCode: 'INFERENCE_RESULT_RECORDED',
      severity: 'low',
      title: `InferenceResultRecorded: ${row.level} ${row.label}`,
      status: 'open',
      sourceType: 'inference',
      orgId,
      createdAt: now,
      evidenceJson: {
        inferenceId: row.inferenceId,
        subjectId: row.subjectId,
        level: row.level,
        modelId: row.modelId,
        modelVersion: row.modelVersion,
        inputVersion: row.inputVersion,
        label: row.label,
        confidence: row.confidence,
        oodIndicator: { flag: row.oodFlag, reasons: row.oodReasons },
        dataQuality: row.dataQuality,
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
