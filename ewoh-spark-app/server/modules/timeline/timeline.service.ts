import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohEvent } from '@server/database/schema';
import { eq, desc, and, gte, type SQL } from 'drizzle-orm';
import type { TimelineEvent } from '@shared/api.interface';
import { clampEventWindowHours, clampListLimit } from '@shared/query-params';
import type { OrgContext } from '../shared/org-context.interceptor';
import { buildTimelineEvents } from './timeline.projection';

/**
 * 统一对象时间线服务。
 *
 * 复用 ewoh_event 数据源，将领域事件投影为统一 TimelineEvent DTO。
 * NEST-623（2026-08-17 审计整改）：显式 org 谓词 + limit 上限（原先仅
 * status 过滤且 parseInt 无上限，跨租户全表可拉取）；鉴权由控制器 Roles 守卫保证。
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async getTimelineEvents(
    limit = 100,
    status?: string,
    actor?: OrgContext,
    hours?: number,
  ): Promise<TimelineEvent[]> {
    try {
      // 清洗逻辑收敛至 @shared/query-params（与 dashboard/events 同语义，单一事实源）。
      const safeLimit = clampListLimit(limit, 100);
      // 时间窗滚动查询（2026-08-19）：默认 24h，clamp [1,168]——
      // 事件表高写入量，无窗全表扫描在峰值时拖垮平台。
      const safeHours = clampEventWindowHours(hours);
      const conditions: SQL[] = [];
      if (!actor?.isGlobalAdmin) {
        const orgId = actor?.primaryOrgId?.trim();
        if (!orgId) {
          throw new BadRequestException(
            'org context missing: timeline queries require tenant context',
          );
        }
        conditions.push(eq(ewohEvent.orgId, orgId));
      }
      if (status) conditions.push(eq(ewohEvent.status, status));
      conditions.push(
        gte(ewohEvent.createdAt, new Date(Date.now() - safeHours * 3_600_000)),
      );
      const rows = await this.db
        .select()
        .from(ewohEvent)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohEvent.createdAt))
        .limit(safeLimit);
      return buildTimelineEvents(
        rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt ? r.createdAt.toISOString() : null,
          eventId: r.eventId,
          title: r.title,
          severity: r.severity,
          status: r.status,
          deviceId: r.deviceId,
          eventType: r.eventType,
          eventCode: r.eventCode,
          sourceType: r.sourceType,
          triggerRecordId: r.triggerRecordId,
          evidenceJson: (r.evidenceJson as Record<string, unknown> | null | undefined),
        })),
      );
    } catch (error) {
      this.logger.error('getTimelineEvents 失败', error);
      throw error;
    }
  }
}
