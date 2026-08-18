import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, lt, asc, sql, and } from 'drizzle-orm';
import { ewohTraceSpan, ewohEvent, ewohAuditLog } from '@server/database/schema';

export interface TraceRecord {
  traceId: string;
  spanId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
  /** lineage（可空）：请求租户/用户——观测基建跨租户诊断诉求。 */
  orgId?: string | null;
  requestUser?: string | null;
}

export interface TraceStitch {
  traceId: string;
  spans: unknown[];
  events: unknown[];
  audit: unknown[];
}

/** span 保留期（天）与单表行上限（追踪索引，非审计资产——ADR-022 决策 2）。 */
export const TRACE_SPAN_TTL_DAYS = 7;
export const TRACE_SPAN_MAX_ROWS = 200_000;

/**
 * TracingService（ADR-022 / NO-10a，§19 全链路 trace）：
 * - HTTP span 持久化（ewoh_trace_span，standalone_042）——写入即清理
 *   7 天 TTL 旧行 + 行上限防爆（bounded；追踪索引非审计资产，审计事实在
 *   ewoh_audit_log）；写入失败 logger 留痕不阻断（interceptor best-effort）；
 * - 缝合查询 getTrace(traceId)：spans + events（envelope correlationId）+
 *   audit（request_id）三面——§19「从一次用户操作追踪到…」查询面；
 * - 内存记录保留（list/clear 兼容既有 traces 列表 API）。
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private readonly records: TraceRecord[] = [];
  private readonly maxRecords: number;
  // R2-SNZ-017：独立持久化计数器（原先用 records.length % 20 触发清理，
  // 环形缓冲填满后 length 恒定 → 每次请求都全表 count/delete）。
  private persistCount = 0;

  constructor(
    @Optional() maxRecords?: number,
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: PostgresJsDatabase,
  ) {
    this.maxRecords = maxRecords ?? 500;
  }

  record(entry: TraceRecord): TraceRecord {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return entry;
  }

  /**
   * span 持久化（interceptor 调用，best-effort：失败留痕不抛出——
   * 追踪索引丢失不影响业务事实层；审计链由 ewoh_audit_log 独立保证）。
   */
  async persistSpan(entry: TraceRecord): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.insert(ewohTraceSpan).values({
        traceId: entry.traceId,
        spanId: entry.spanId,
        path: entry.path,
        method: entry.method,
        statusCode: entry.status,
        durationMs: entry.durationMs,
        startedAt: new Date(entry.startedAt),
        finishedAt: new Date(entry.finishedAt),
        error: entry.error ?? null,
        orgId: entry.orgId ?? null,
        requestUser: entry.requestUser ?? null,
      });
      // bounded 清理：7 天 TTL + 行上限（每 N 次写入清理一次，避免每次全扫）。
      // P1（2026-08-19 审计）：改用独立持久化计数器触发——原 records.length % 20
      // 在环形缓冲填满后 length 恒定，取模恒命中固定相位 → 每次请求（或永不）
      // 全表 count/delete（trace_span 20 万行级）。persistCount 声明已久，
      // 此前从未接线。
      this.persistCount += 1;
      if (this.persistCount % 20 === 0) {
        await this.enforceBounds();
      }
    } catch (error) {
      this.logger.warn(`trace span 持久化失败（追踪索引，不影响业务）: ${String(error)}`);
    }
  }

  /** TTL + 行上限清理（幂等；仅 DB 路径）。 */
  async enforceBounds(): Promise<void> {
    if (!this.db) return;
    try {
      const cutoff = new Date(Date.now() - TRACE_SPAN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await this.db.delete(ewohTraceSpan).where(lt(ewohTraceSpan.startedAt, cutoff));
      // ADR-078：drizzle 类型安全路径（消除 public. 硬编码）。
      const countRows = await this.db
        .select({ total: sql`count(*)::int` })
        .from(ewohTraceSpan);
      const total = Number((countRows[0] as { total: number } | undefined)?.total ?? 0);
      if (total > TRACE_SPAN_MAX_ROWS) {
        await this.db.delete(ewohTraceSpan).where(
          lt(
            ewohTraceSpan.startedAt,
            sql`(select started_at from ${ewohTraceSpan}
                order by started_at desc offset ${TRACE_SPAN_MAX_ROWS} limit 1)`,
          ),
        );
      }
    } catch (error) {
      this.logger.warn(`trace span 清理失败: ${String(error)}`);
    }
  }

  /** 三面缝合（§19）：spans + events（envelope correlationId）+ audit（request_id）。
   * NEST-624（2026-08-17 审计整改）：三面查询均带 org 谓词（原先按 traceId
   * 跨租户缝合）。 */
  async getTrace(traceId: string, actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }): Promise<TraceStitch> {
    const empty: TraceStitch = { traceId, spans: [], events: [], audit: [] };
    if (!this.db) {
      empty.spans = this.records.filter((r) => r.traceId === traceId);
      return empty;
    }
    const orgId = actor?.isGlobalAdmin ? null : actor?.primaryOrgId?.trim() ?? null;
    if (orgId === null) {
      throw new BadRequestException(
        'org context missing: trace stitching requires tenant context',
      );
    }
    try {
      const [spans, events, audit] = await Promise.all([
        this.db
          .select()
          .from(ewohTraceSpan)
          .where(
            and(
              eq(ewohTraceSpan.traceId, traceId),
              eq(ewohTraceSpan.orgId, orgId),
            ),
          )
          .orderBy(desc(ewohTraceSpan.startedAt))
          .limit(200),
        // ADR-078：drizzle 类型安全路径（消除 public. 硬编码）。
        this.db
          .select({
            // 契约兼容：stitch 面保持既有 snake_case 字段名（旧 raw SQL 输出）。
            event_id: ewohEvent.eventId,
            event_type: ewohEvent.eventType,
            severity: ewohEvent.severity,
            title: ewohEvent.title,
            created_at: ewohEvent.createdAt,
            correlation_id: sql`evidence_json->'envelope'->>'correlationId'`,
          })
          .from(ewohEvent)
          .where(
            and(
              sql`evidence_json->'envelope'->>'correlationId' = ${traceId}`,
              eq(ewohEvent.orgId, orgId),
            ),
          )
          .orderBy(asc(ewohEvent.createdAt))
          .limit(200),
        this.db
          .select({
            action: ewohAuditLog.action,
            entity_type: ewohAuditLog.entityType,
            entity_id: ewohAuditLog.entityId,
            actor_id: ewohAuditLog.actorId,
            occurred_at: ewohAuditLog.occurredAt,
            request_id: ewohAuditLog.requestId,
          })
          .from(ewohAuditLog)
          .where(
            and(
              eq(ewohAuditLog.requestId, traceId),
              eq(ewohAuditLog.orgId, orgId),
            ),
          )
          .orderBy(asc(ewohAuditLog.occurredAt))
          .limit(200),
      ]);
      return { traceId, spans, events, audit };
    } catch (error) {
      this.logger.error(`trace 缝合查询失败 ${traceId}: ${String(error)}`);
      throw error;
    }
  }

  /**
   * R2-SNZ-007：列表按调用者租户过滤（原先全租户混存直出；global_admin
   * 放行，非 global 缺租户 fail-closed 400——与 getTrace 语义一致）。
   */
  list(limit = 100, actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }): TraceRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    if (actor?.isGlobalAdmin) {
      return [...this.records].reverse().slice(0, safeLimit);
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: trace list requires tenant context',
      );
    }
    return [...this.records]
      .reverse()
      .filter((r) => r.orgId === orgId)
      .slice(0, safeLimit);
  }

  clear(): void {
    this.records.length = 0;
  }
}
