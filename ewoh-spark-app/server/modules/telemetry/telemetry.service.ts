import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohEvent } from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * UI 埋点落库（路线图 A1 / J1 PRD Q-6 / J2 Gate G-1）。
 *
 * 写入 `ewoh_event`（eventType='ui_telemetry'），**不新建表、不做迁移**——
 * 事件表已有按 (orgId, eventType, createdAt) 的复合索引，按天聚合直接可查：
 *
 * ```sql
 * SELECT event_code, date_trunc('day', created_at) AS d, count(*)
 * FROM ewoh_event
 * WHERE event_type = 'ui_telemetry'
 * GROUP BY 1, 2 ORDER BY 2;
 * ```
 *
 * 设计约束：
 * - **静默失败**：埋点绝不影响业务路径——非法事件跳过、写库失败返回 accepted=0，
 *   全程不抛 500（controller 层再兜一层）。
 * - **白名单**：端点公开可写，事件名必须命中白名单，防止刷库。
 * - **批量上限**：单请求最多 MAX_BATCH 条。
 */

export interface TelemetryEventInput {
  name: string;
  /** 事件发生时间（epoch ms）；缺省用服务端接收时间。 */
  at?: number;
  props?: Record<string, unknown>;
}

/** 与 client/src/lib/telemetry.ts 的 TelemetryEventName 保持一致（新增事件须同步）。 */
const ALLOWED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'object_workbench_view',
  'approval_deeplink_click',
  'terminal_action_click',
  'nav_source',
]);

export const TELEMETRY_MAX_BATCH = 50;

const EVENT_TYPE = 'ui_telemetry';

@Injectable()
export class TelemetryService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async recordBatch(
    events: TelemetryEventInput[] | undefined,
    actor?: OrgContext,
  ): Promise<{ accepted: number }> {
    if (!Array.isArray(events) || events.length === 0) return { accepted: 0 };
    const bounded = events.slice(0, TELEMETRY_MAX_BATCH);
    const orgId = actor?.primaryOrgId?.trim() || null;
    const receivedAt = new Date();

    type TelemetryInsert = typeof ewohEvent.$inferInsert;
    const rows: TelemetryInsert[] = [];
    for (const event of bounded) {
      if (!event || typeof event.name !== 'string') continue;
      if (!ALLOWED_EVENT_NAMES.has(event.name)) continue;
      const occurredAt =
        typeof event.at === 'number' && Number.isFinite(event.at) && event.at > 0
          ? new Date(event.at)
          : receivedAt;
      rows.push({
        eventId: `tel-${randomUUID()}`,
        eventType: EVENT_TYPE,
        eventCode: event.name.slice(0, 255),
        title: event.name.slice(0, 500),
        // 埋点无生命周期，直接终态，避免混入任何 pending 语义的查询。
        status: 'closed',
        sourceType: 'telemetry',
        createdAt: occurredAt,
        occurredAt,
        receivedAt,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        triggerRecordId: null,
        handlerAction: null,
        deviceId: null,
        severity: null,
        orgId,
        evidenceJson: { props: event.props ?? {} },
      });
    }

    if (rows.length === 0) return { accepted: 0 };

    try {
      await this.db.insert(ewohEvent).values(rows);
      return { accepted: rows.length };
    } catch {
      // 埋点静默失败：写库异常不影响业务，也不向上暴露细节。
      return { accepted: 0 };
    }
  }

  /**
   * 按事件名 + 日聚合查询（基线采集与指标看板用，路线图 A1）。
   *
   * 时间窗默认近 30 天，clamp 到 [1, 366] 天；org 过滤与写入口径一致。
   */
  async summarize(
    actor: OrgContext | undefined,
    range?: { from?: string; to?: string },
  ): Promise<{
    from: string;
    to: string;
    total: number;
    byName: Record<string, number>;
  }> {
    const to = range?.to ? new Date(range.to) : new Date();
    const from = range?.from
      ? new Date(range.from)
      : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from/to 必须是合法的日期');
    }
    // clamp 366 天，防止全表扫描。
    const maxSpan = 366 * 24 * 3600 * 1000;
    const effectiveFrom =
      to.getTime() - from.getTime() > maxSpan
        ? new Date(to.getTime() - maxSpan)
        : from;
    const orgId = actor?.primaryOrgId?.trim() ?? null;

    const rows = (await this.db
      .select({
        eventCode: ewohEvent.eventCode,
        day: sql<string>`to_char(date_trunc('day', ${ewohEvent.createdAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventType, EVENT_TYPE),
          orgId ? eq(ewohEvent.orgId, orgId) : sql`true`,
          gte(ewohEvent.createdAt, effectiveFrom),
          lte(ewohEvent.createdAt, to),
        ),
      )
      .groupBy(ewohEvent.eventCode, sql`date_trunc('day', ${ewohEvent.createdAt})`)
      .orderBy(sql`date_trunc('day', ${ewohEvent.createdAt})`)) as Array<{
      eventCode: string | null;
      day: string;
      count: number;
    }>;

    const byName: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const name = row.eventCode ?? 'unknown';
      byName[name] = (byName[name] ?? 0) + row.count;
      total += row.count;
    }
    return {
      from: effectiveFrom.toISOString(),
      to: to.toISOString(),
      total,
      byName,
    };
  }
}
