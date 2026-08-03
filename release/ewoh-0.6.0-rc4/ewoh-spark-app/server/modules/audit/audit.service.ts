import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, sql, type SQL } from 'drizzle-orm';

export interface AuditQuery {
  entityType?: string;
  action?: string;
  actorId?: string;
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
    const conditions: SQL[] = [];
    if (query.entityType) {
      conditions.push(sql`entity_type = ${query.entityType}`);
    }
    if (query.action) {
      conditions.push(sql`action = ${query.action}`);
    }
    if (query.actorId) {
      conditions.push(sql`actor_id = ${query.actorId}`);
    }
    const where = conditions.length > 0 ? sql`where ${and(...conditions)}` : sql``;

    const [countRow] = await this.db.execute(
      sql`select count(*)::int as total from public.ewoh_audit_log ${where}`,
    );
    const rows = await this.db.execute(
      sql`
        select id, org_id, audit_seq, actor_id, action, entity_type, entity_id,
               before_json, after_json, reason, client_ip, request_id,
               risk_level, is_high_risk, occurred_at, chain_seq, prev_hash, hash
        from public.ewoh_audit_log
        ${where}
        order by audit_seq desc
        limit ${query.limit}
        offset ${query.offset}
      `,
    );

    return {
      items: rows.map((row) => toRow(row as Record<string, unknown>, query.includeClientIp === true)),
      total: Number((countRow as Record<string, unknown>).total),
      limit: query.limit,
      offset: query.offset,
    };
  }
}
