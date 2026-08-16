import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohAuditLog } from '@server/database/schema';
import { and, sql, eq, desc, type SQL } from 'drizzle-orm';

export interface AuditQuery {
  entityType?: string;
  action?: string;
  actorId?: string;
  /** ADR-078：可选 org 过滤（缺失=RLS 语义现状）。 */
  orgId?: string;
  limit: number;
  offset: number;
  includeClientIp?: boolean;
}

export interface AuditLogRow {
  id: string;
  orgId: string | null;
  auditSeq: number;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  clientIp: string | null;
  requestId: string | null;
  riskLevel: string;
  isHighRisk: boolean;
  occurredAt: string;
  chainSeq: number;
  prevHash: string;
  hash: string;
}

function toRow(row: Record<string, unknown>, includeClientIp = false): AuditLogRow {
  return {
    id: String(row.id),
    orgId: row.org_id ? String(row.org_id) : null,
    auditSeq: Number(row.audit_seq),
    actorId: String(row.actor_id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    before: row.before_json ?? null,
    after: row.after_json ?? null,
    reason: row.reason ? String(row.reason) : null,
    clientIp: includeClientIp && row.client_ip ? String(row.client_ip) : null,
    requestId: row.request_id ? String(row.request_id) : null,
    riskLevel: String(row.risk_level),
    isHighRisk: Boolean(row.is_high_risk),
    occurredAt: String(row.occurred_at),
    chainSeq: Number(row.chain_seq),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

@Injectable()
export class AuditQueryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async list(query: AuditQuery): Promise<{ items: AuditLogRow[]; total: number; limit: number; offset: number }> {
    // ADR-078：drizzle 类型安全路径（消除 public. 硬编码）。
    const conditions: SQL[] = [];
    if (query.entityType) {
      conditions.push(eq(ewohAuditLog.entityType, query.entityType));
    }
    if (query.action) {
      conditions.push(eq(ewohAuditLog.action, query.action));
    }
    if (query.actorId) {
      conditions.push(eq(ewohAuditLog.actorId, query.actorId));
    }
    if (query.orgId) {
      conditions.push(eq(ewohAuditLog.orgId, query.orgId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRows, rows] = await Promise.all([
      this.db
        .select({ total: sql`count(*)::int` })
        .from(ewohAuditLog)
        .where(where),
      this.db
        .select({
          id: ewohAuditLog.id,
          orgId: ewohAuditLog.orgId,
          auditSeq: ewohAuditLog.auditSeq,
          actorId: ewohAuditLog.actorId,
          action: ewohAuditLog.action,
          entityType: ewohAuditLog.entityType,
          entityId: ewohAuditLog.entityId,
          beforeJson: ewohAuditLog.beforeJson,
          afterJson: ewohAuditLog.afterJson,
          reason: ewohAuditLog.reason,
          clientIp: ewohAuditLog.clientIp,
          requestId: ewohAuditLog.requestId,
          riskLevel: ewohAuditLog.riskLevel,
          isHighRisk: ewohAuditLog.isHighRisk,
          occurredAt: ewohAuditLog.occurredAt,
          chainSeq: ewohAuditLog.chainSeq,
          prevHash: ewohAuditLog.prevHash,
          hash: ewohAuditLog.hash,
        })
        .from(ewohAuditLog)
        .where(where)
        .orderBy(desc(ewohAuditLog.auditSeq))
        .limit(query.limit)
        .offset(query.offset),
    ]);

    return {
      items: rows.map((row) => toRow({
        id: row.id,
        org_id: row.orgId,
        audit_seq: row.auditSeq,
        actor_id: row.actorId,
        action: row.action,
        entity_type: row.entityType,
        entity_id: row.entityId,
        before_json: row.beforeJson,
        after_json: row.afterJson,
        reason: row.reason,
        client_ip: row.clientIp,
        request_id: row.requestId,
        risk_level: row.riskLevel,
        is_high_risk: row.isHighRisk,
        occurred_at: row.occurredAt,
        chain_seq: row.chainSeq,
        prev_hash: row.prevHash,
        hash: row.hash,
      } as Record<string, unknown>, query.includeClientIp === true)),
      total: Number((countRows[0] as { total: number } | undefined)?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  }
}
