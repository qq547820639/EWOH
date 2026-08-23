import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray } from 'drizzle-orm';
import { ewohIdentityMapping, ewohEvent } from '@server/database/schema';
import {
  parseIdentity,
  resolveIdentityMapping,
  validateMappingRecord,
  type IdentityMappingRecord,
} from '@shared/identity';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';

/** 注册/解析接口的输入（映射记录 + 租户上下文注入）。 */
export interface RegisterMappingInput {
  mappingId: string;
  version: number;
  source: { system: string; id: string; idKind?: string };
  target: { entityId: string };
  authority: 'registration' | 'adapter' | 'manual';
  validFrom?: string | null;
  validTo?: string | null;
  evidenceId?: string | null;
}

export interface ResolvedIdentity {
  entityId: string;
  kind: string;
  value: string;
}

/**
 * Identity 服务（ADR-006 / NO-02b）：第三方系统 ID → EWOH 规范身份的注册与解析。
 *
 * - 契约语义复用 shared/identity.ts（与边缘 Python 同向量一致性）；
 * - 注册幂等：(org_id, source_system, source_id) 唯一；同目标重登记 = 版本递增更新，
 *   不同目标 = 旧记录 superseded + 新 active 记录（fail-closed：绝不静默改身份）；
 * - 解析走共享 resolveIdentityMapping（active/时间窗口/ambiguous_identity）；
 * - 每次注册写 ewoh_event（eventType=EntityIdentityMapped，事件目录契约）；
 * - 租户边界：所有查询带 orgId + DB 层 RLS（standalone_032）双保险。
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 注册（或幂等更新）一条身份映射；返回落库记录视图 + 是否为新注册。 */
  async registerMapping(
    input: RegisterMappingInput,
    orgId: string,
  ): Promise<{ record: IdentityMappingRecord; created: boolean; superseded: boolean }> {
    if (!orgId) {
      throw new BadRequestException('orgId 缺失：身份映射注册必须带租户上下文');
    }
    const errors = validateMappingRecord({
      ...input,
      recordedAt: new Date().toISOString(),
      status: 'active',
    });
    if (errors.length > 0) {
      throw new BadRequestException(`身份映射记录违反契约: ${errors.join(', ')}`);
    }
    const { kind } = parseIdentity(input.target.entityId);

    const existing = await this.db
      .select()
      .from(ewohIdentityMapping)
      .where(
        and(
          eq(ewohIdentityMapping.orgId, orgId),
          eq(ewohIdentityMapping.sourceSystem, input.source.system),
          eq(ewohIdentityMapping.sourceId, input.source.id),
        ),
      );

    let superseded = false;
    const now = new Date();
    if (existing.length > 0) {
      const active = existing.find((r) => r.status === 'active');
      if (active && active.targetEntityId === input.target.entityId) {
        // 幂等重登记：版本 +1，更新登记时间（唯一约束下的同键更新）。
        await this.db
          .update(ewohIdentityMapping)
          .set({
            version: Math.max(active.version, input.version) + 1,
            authority: input.authority,
            recordedAt: now,
            validFrom: input.validFrom ? new Date(input.validFrom) : active.validFrom,
            validTo: input.validTo ? new Date(input.validTo) : active.validTo,
            evidenceId: input.evidenceId ?? active.evidenceId,
            updatedAt: now,
          })
          .where(and(eq(ewohIdentityMapping.orgId, orgId), eq(ewohIdentityMapping.id, active.id)));
        const updated = await this.db
          .select()
          .from(ewohIdentityMapping)
          .where(and(eq(ewohIdentityMapping.orgId, orgId), eq(ewohIdentityMapping.id, active.id)))
          .limit(1);
        const record = this.toRecord(updated[0]);
        return { record, created: false, superseded: false };
      }
      // 目标身份变更：旧 active → superseded（历史留痕，不静默覆盖）。
      await this.db
        .update(ewohIdentityMapping)
        .set({ status: 'superseded', updatedAt: now })
        .where(
          and(
            eq(ewohIdentityMapping.orgId, orgId),
            eq(ewohIdentityMapping.sourceSystem, input.source.system),
            eq(ewohIdentityMapping.sourceId, input.source.id),
            eq(ewohIdentityMapping.status, 'active'),
          ),
        );
      superseded = true;
    }

    const row = {
      orgId,
      mappingId: input.mappingId || `map:${randomUUID()}`,
      version: input.version >= 1 ? input.version : 1,
      sourceSystem: input.source.system,
      sourceId: input.source.id,
      sourceIdKind: input.source.idKind ?? null,
      targetEntityId: input.target.entityId,
      targetKind: kind,
      authority: input.authority,
      status: 'active' as const,
      recordedAt: now,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
      evidenceId: input.evidenceId ?? null,
    };
    let inserted;
    try {
      inserted = await this.db.insert(ewohIdentityMapping).values(row).returning();
    } catch (err) {
      // NEST-435：并发 supersede+insert 竞态（唯一约束 (org, system, id) 冲突）
      // → 回读既有行（幂等收敛），不再向调用方抛 500。
      if ((err as { code?: string }).code === '23505') {
        const rows = await this.db
          .select()
          .from(ewohIdentityMapping)
          .where(
            and(
              eq(ewohIdentityMapping.orgId, orgId),
              eq(ewohIdentityMapping.sourceSystem, input.source.system),
              eq(ewohIdentityMapping.sourceId, input.source.id),
              eq(ewohIdentityMapping.status, 'active'),
            ),
          )
          .limit(1);
        if (
          rows.length > 0 &&
          rows[0].targetEntityId === input.target.entityId
        ) {
          const record = this.toRecord(rows[0]);
          return { record, created: false, superseded };
        }
        throw new BadRequestException(
          'conflict_identity_mapping：并发注册冲突（目标不一致，请重试）',
        );
      }
      throw err;
    }
    const record = this.toRecord(inserted[0]);
    await this.recordEvent(orgId, record);
    return { record, created: true, superseded };
  }

  /** 解析 (system, id) → 规范身份；未映射返回 null（fail-closed）。 */
  async resolveMapping(system: string, id: string, orgId: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(ewohIdentityMapping)
      .where(
        and(
          eq(ewohIdentityMapping.orgId, orgId),
          eq(ewohIdentityMapping.sourceSystem, system),
          eq(ewohIdentityMapping.sourceId, id),
        ),
      );
    if (rows.length === 0) return null;
    return resolveIdentityMapping(system, id, rows.map((r) => this.toRecord(r)));
  }

  /** ingest 批量解析：一次 IN 查询（≤BATCH_LIMIT），返回 Map<sourceId, entityId>。 */
  async resolveBatch(
    system: string,
    ids: string[],
    orgId: string,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const distinct = [...new Set(ids.filter((x) => x && x.length > 0 && x.length <= 255))];
    if (distinct.length === 0) return result;
    const rows = await this.db
      .select()
      .from(ewohIdentityMapping)
      .where(
        and(
          eq(ewohIdentityMapping.orgId, orgId),
          eq(ewohIdentityMapping.sourceSystem, system),
          inArray(ewohIdentityMapping.sourceId, distinct),
        ),
      );
    const now = new Date().toISOString();
    for (const sourceId of distinct) {
      const candidates = rows.filter((r) => r.sourceId === sourceId);
      if (candidates.length === 0) continue;
      try {
        const resolved = resolveIdentityMapping(
          system,
          sourceId,
          candidates.map((r) => this.toRecord(r)),
          now,
        );
        if (resolved) result.set(sourceId, resolved);
      } catch (err) {
        // ambiguous_identity：fail-closed 不解析（遥测仍按 legacy deviceId 落库，
        // 不阻断 ingest 主链路），冲突显式留痕日志。
        this.logger.warn(
          `identity resolve failed-closed for ${system}:${sourceId}: ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  /** 列表（租户内；可按 system/status 过滤）。 */
  async listMappings(
    orgId: string,
    filters?: { system?: string; status?: string },
  ): Promise<IdentityMappingRecord[]> {
    const conditions = [eq(ewohIdentityMapping.orgId, orgId)];
    if (filters?.system) conditions.push(eq(ewohIdentityMapping.sourceSystem, filters.system));
    if (filters?.status) conditions.push(eq(ewohIdentityMapping.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohIdentityMapping)
      .where(and(...conditions))
      .limit(500);
    return rows.map((r) => this.toRecord(r));
  }

  /** DB 行 → 契约 IdentityMappingRecord 形状（与 shared resolveIdentityMapping 消费一致）。 */
  private toRecord(row: typeof ewohIdentityMapping.$inferSelect): IdentityMappingRecord {
    return {
      mappingId: row.mappingId,
      version: row.version,
      source: {
        system: row.sourceSystem,
        id: row.sourceId,
        ...(row.sourceIdKind ? { idKind: row.sourceIdKind } : {}),
      },
      target: { entityId: row.targetEntityId },
      authority: row.authority as IdentityMappingRecord['authority'],
      status: row.status as IdentityMappingRecord['status'],
      recordedAt: row.recordedAt.toISOString(),
      validFrom: row.validFrom ? row.validFrom.toISOString() : null,
      validTo: row.validTo ? row.validTo.toISOString() : null,
      evidenceId: row.evidenceId ?? null,
    };
  }

  /** 事件落库：eventType=EntityIdentityMapped（目录契约 contracts/events/event-catalog.yaml）。 */
  private async recordEvent(orgId: string, record: IdentityMappingRecord): Promise<void> {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    // ADR-009 / NO-04b：事件信封嵌入（目录类型 EntityIdentityMapped）。
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'EntityIdentityMapped',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:identity',
      subject: record.target.entityId,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'EntityIdentityMapped',
      eventCode: 'IDENTITY_MAPPED',
      severity: 'low',
      title: `身份映射登记: ${record.source.system}:${record.source.id} → ${record.target.entityId}`,
      status: 'open',
      sourceType: 'identity',
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
        mappingId: record.mappingId,
        sourceSystem: record.source.system,
        sourceId: record.source.id,
        entityId: record.target.entityId,
        authority: record.authority,
        recordedAt: record.recordedAt,
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
