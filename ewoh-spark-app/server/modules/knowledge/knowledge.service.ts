import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray, or } from 'drizzle-orm';
import { ewohKnowledgeEntry, ewohEvent } from '@server/database/schema';
import { validateKnowledgeEntry } from '@shared/knowledge-entry';
import { isCanonicalIdentity } from '@shared/identity';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
// NEST-434：哨兵常量统一登记（server/common/org-sentinels.ts），本模块再导出保持兼容。
import { PLATFORM_SHARED_ORG_ID as SHARED_SENTINEL } from '@server/common/org-sentinels';

/** 平台保留哨兵 org：共享层（global/industry）条目的归属（ADR-018 Amendment 1 决策 2）。 */
export const PLATFORM_SHARED_ORG_ID = SHARED_SENTINEL;

export const SHARED_KNOWLEDGE_SCOPES = ['global', 'industry'] as const;
export const TENANT_KNOWLEDGE_SCOPES = ['customer', 'factory', 'private_operational'] as const;
const SHARED_SET: ReadonlySet<string> = new Set(SHARED_KNOWLEDGE_SCOPES);
const TENANT_SET: ReadonlySet<string> = new Set(TENANT_KNOWLEDGE_SCOPES);

export interface RegisterKnowledgeEntryInput {
  knowledgeId?: string | null;
  kind: string;
  scope: string;
  title: string;
  summary?: string | null;
  body: string;
  sourceEvidenceIds: string[];
  relatedEntityIds?: string[];
  tags?: string[];
  version?: number;
  verifiedBy?: string | null;
  tenantId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  provenance?: Record<string, unknown> | null;
}

export interface RetrieveKnowledgeFilters {
  kind?: string;
  scope?: string;
  status?: string;
}

/** 状态转移语义（ADR-018 Amendment 1 决策 8）：draft→verified（必须 verifiedBy）/
 *  draft→superseded / verified→superseded；superseded 终态；共享层条目租户只读。 */
const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  draft: new Set(['verified', 'superseded']),
  verified: new Set(['superseded']),
  superseded: new Set([]),
};

/**
 * Knowledge 服务（ADR-018 Amendment 1 / NO-07b）：知识条目唯一权威写路径。
 *
 * - 契约校验 fail-closed（shared/knowledge-entry.ts validateKnowledgeEntry，
 *   与边缘 Python 同向量）；tenantId 必须与调用租户一致（跨租户写显式拒绝）；
 * - 五层 scope 阶梯（Amendment 1 决策 4，service 层与 RLS 双强制）：
 *    租户检索可见 = 共享层（global+industry，哨兵 org）∪ 本租户层
 *    （customer/factory/private_operational）；共享检索仅 global+industry，
 *    请求带租户层 scope 时 fail-closed 拒绝——绝不越过 private_operational；
 * - 创建幂等：唯一 (org_id, entry_id) 冲突 → 返回既有行，不重复发事件；
 * - 共享层条目落哨兵 org（00000000-0000-4000-8000-000000000000），
 *    租户层条目落调用租户 org；DB CHECK（scope-tenant 一致性）+ RLS
 *    （knowledge_entry_service_all，standalone_039）兜底；
 * - 事件：创建 → KnowledgeEntryCreated（Canonical Catalog 信封，54 类）；
 * - 状态转移：draft→verified 必须 verifiedBy（规范身份）；superseded 终态；
 *    共享层条目对租户只读（平台维护）。
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async registerEntry(input: RegisterKnowledgeEntryInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：知识条目注册必须带租户上下文');
    }
    if (!SHARED_SET.has(input.scope) && !TENANT_SET.has(input.scope)) {
      throw new BadRequestException(`unknown_scope:${input.scope}`);
    }
    const tenantScoped = TENANT_SET.has(input.scope);
    if (tenantScoped && input.tenantId != null && input.tenantId !== orgId) {
      // 跨租户写显式拒绝（fail-closed；绝不静默改归属）
      throw new BadRequestException('cross_tenant_register_forbidden');
    }
    const knowledgeId = input.knowledgeId && input.knowledgeId !== ''
      ? input.knowledgeId
      : this.deriveKnowledgeId();
    const record: Record<string, unknown> = {
      knowledgeId,
      kind: input.kind,
      scope: input.scope,
      title: input.title,
      summary: input.summary && input.summary !== '' ? input.summary : input.title,
      body: input.body,
      sourceEvidenceIds: input.sourceEvidenceIds ?? [],
      relatedEntityIds: input.relatedEntityIds ?? [],
      tags: input.tags ?? [],
      version: input.version ?? 1,
      status: 'draft',
      timeSemantics: {
        validFrom: input.validFrom ?? new Date().toISOString(),
        ...(input.validTo ? { validTo: input.validTo } : {}),
      },
      auditTrail: true,
      ...(tenantScoped ? { tenantId: orgId } : {}),
      ...(input.verifiedBy ? { verifiedBy: input.verifiedBy } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };
    const errors = validateKnowledgeEntry(record);
    if (errors.length > 0) {
      throw new BadRequestException(`知识条目违反契约: ${errors.join(', ')}`);
    }
    const targetOrg = tenantScoped ? orgId : PLATFORM_SHARED_ORG_ID;
    const row = {
      orgId: targetOrg,
      entryId: knowledgeId,
      baseId: null,
      title: record.title as string,
      summary: record.summary as string,
      body: record.body as string,
      tags: record.tags as string[],
      kind: input.kind,
      scope: input.scope,
      status: 'draft' as const,
      version: record.version as number,
      sourceEvidenceIds: record.sourceEvidenceIds as string[],
      relatedEntityIds: record.relatedEntityIds as string[],
      provenance: input.provenance ?? null,
      verifiedBy: input.verifiedBy ?? null,
      validFrom: new Date((record.timeSemantics as Record<string, string>).validFrom),
      validTo: input.validTo ? new Date(input.validTo) : null,
      auditTrail: true,
      legacyWithoutEvidence: false,
    };
    let inserted;
    try {
      const result = await this.db.insert(ewohKnowledgeEntry).values(row).returning();
      inserted = result[0];
      await this.recordEvent(inserted, knowledgeId, targetOrg);
    } catch (err) {
      // 幂等重放：唯一 (org_id, entry_id) 冲突 → 返回既有行，不重复发事件
      // （绝不静默吞其他异常——非 23505 一律重抛）。
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohKnowledgeEntry)
        .where(and(eq(ewohKnowledgeEntry.orgId, targetOrg), eq(ewohKnowledgeEntry.entryId, knowledgeId)))
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`知识条目幂等重放命中: ${knowledgeId}`);
      return { record: this.toEntry(existing[0]), created: false };
    }
    return { record: this.toEntry(inserted), created: true };
  }

  /** 租户检索阶梯：共享层 ∪ 本租户层（Amendment 1 决策 4）。 */
  async retrieveEntries(orgId: string, filters?: RetrieveKnowledgeFilters) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：知识检索必须带租户上下文');
    }
    if (filters?.scope && !SHARED_SET.has(filters.scope) && !TENANT_SET.has(filters.scope)) {
      throw new BadRequestException(`unknown_scope:${filters.scope}`);
    }
    const conditions = [this.visiblePredicate(orgId)];
    if (filters?.kind) conditions.push(eq(ewohKnowledgeEntry.kind, filters.kind));
    if (filters?.scope) conditions.push(eq(ewohKnowledgeEntry.scope, filters.scope));
    if (filters?.status) conditions.push(eq(ewohKnowledgeEntry.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohKnowledgeEntry)
      .where(and(...conditions))
      .limit(500);
    return rows.map((r) => this.toEntry(r));
  }

  /** 共享检索（跨租户目录视图）：仅 global+industry；租户层 scope 请求 fail-closed。 */
  async retrieveSharedEntries(filters?: RetrieveKnowledgeFilters) {
    if (filters?.scope && !SHARED_SET.has(filters.scope)) {
      throw new BadRequestException(
        `shared_scope_only:${filters.scope}（共享检索绝不越过 global/industry，private_operational 永不出租户）`,
      );
    }
    const conditions = [
      and(
        eq(ewohKnowledgeEntry.orgId, PLATFORM_SHARED_ORG_ID),
        inArray(ewohKnowledgeEntry.scope, [...SHARED_KNOWLEDGE_SCOPES]),
      ),
    ];
    if (filters?.kind) conditions.push(eq(ewohKnowledgeEntry.kind, filters.kind));
    if (filters?.scope) conditions.push(eq(ewohKnowledgeEntry.scope, filters.scope));
    if (filters?.status) conditions.push(eq(ewohKnowledgeEntry.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohKnowledgeEntry)
      .where(and(...conditions))
      .limit(500);
    return rows.map((r) => this.toEntry(r));
  }

  async getEntry(orgId: string, entryId: string): Promise<Record<string, unknown> | null> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：知识查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohKnowledgeEntry)
      .where(and(this.visiblePredicate(orgId), eq(ewohKnowledgeEntry.entryId, entryId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toEntry(rows[0]);
  }

  /** 状态转移（决策 8）：人工 verifiedBy 可审计；共享层条目租户只读。 */
  async transitionStatus(
    orgId: string,
    entryId: string,
    input: { to: string; verifiedBy?: string | null },
  ) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：知识状态转移必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohKnowledgeEntry)
      .where(and(eq(ewohKnowledgeEntry.orgId, orgId), eq(ewohKnowledgeEntry.entryId, entryId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('知识条目不存在（或非本租户/共享层只读）');
    }
    const current = rows[0];
    if (SHARED_SET.has(current.scope)) {
      throw new BadRequestException('shared_entry_readonly：共享层条目由平台维护，租户只读');
    }
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.has(input.to)) {
      throw new BadRequestException(`非法状态转移 ${current.status} → ${input.to}`);
    }
    if (input.to === 'verified') {
      if (!input.verifiedBy || !isCanonicalIdentity(input.verifiedBy)) {
        throw new BadRequestException('verified 状态必须提供 verifiedBy（规范身份，人工可审计）');
      }
    }
    const set: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
    if (input.to === 'verified') set.verifiedBy = input.verifiedBy;
    await this.db
      .update(ewohKnowledgeEntry)
      .set(set)
      .where(and(eq(ewohKnowledgeEntry.orgId, orgId), eq(ewohKnowledgeEntry.id, current.id)));
    return { entryId, from: current.status, to: input.to };
  }

  /** 租户可见谓词：共享层（哨兵 org）∪ 本租户层（GUC 匹配由 RLS 兜底）。 */
  private visiblePredicate(orgId: string) {
    return or(
      and(
        eq(ewohKnowledgeEntry.orgId, PLATFORM_SHARED_ORG_ID),
        inArray(ewohKnowledgeEntry.scope, [...SHARED_KNOWLEDGE_SCOPES]),
      ),
      and(
        eq(ewohKnowledgeEntry.orgId, orgId),
        inArray(ewohKnowledgeEntry.scope, [...TENANT_KNOWLEDGE_SCOPES]),
      ),
    );
  }

  /** knowledge:value 规范身份（EWOH 内部生成，ADR-006；确定性时戳+随机后缀）。 */
  private deriveKnowledgeId(): string {
    return `knowledge:${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
  }

  private toEntry(row: typeof ewohKnowledgeEntry.$inferSelect): Record<string, unknown> {
    return {
      knowledgeId: row.entryId,
      kind: row.kind,
      scope: row.scope,
      title: row.title,
      summary: row.summary,
      body: row.body,
      tags: row.tags,
      version: row.version,
      status: row.status,
      sourceEvidenceIds: row.sourceEvidenceIds,
      relatedEntityIds: row.relatedEntityIds,
      provenance: row.provenance,
      verifiedBy: row.verifiedBy,
      timeSemantics: {
        validFrom: row.validFrom.toISOString(),
        ...(row.validTo ? { validTo: row.validTo.toISOString() } : {}),
      },
      auditTrail: row.auditTrail,
      ...(row.legacyWithoutEvidence ? { legacyWithoutEvidence: true } : {}),
      ...(TENANT_SET.has(row.scope) ? { tenantId: row.orgId } : {}),
    };
  }

  private async recordEvent(
    row: typeof ewohKnowledgeEntry.$inferSelect,
    knowledgeId: string,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'KnowledgeEntryCreated',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:knowledge',
      subject: knowledgeId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'KnowledgeEntryCreated',
      eventCode: 'KNOWLEDGE_ENTRY_CREATED',
      severity: 'low',
      title: `KnowledgeEntryCreated: ${row.kind} ${knowledgeId}`,
      status: 'open',
      sourceType: 'knowledge',
      orgId,
      createdAt: now,
      evidenceJson: {
        knowledgeId,
        kind: row.kind,
        scope: row.scope,
        title: row.title,
        sourceEvidenceIds: row.sourceEvidenceIds,
        relatedEntityIds: row.relatedEntityIds,
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
