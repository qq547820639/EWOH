import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohEvent } from '@server/database/schema';
import { eq, desc, and } from 'drizzle-orm';
import type { TimelineEvent } from '@shared/api.interface';
import { buildTimelineEvents } from './timeline.projection';

/**
 * 统一对象时间线服务。
 *
 * 复用 ewoh_event 数据源，将领域事件投影为统一 TimelineEvent DTO。
 * 走全局 OrgContextInterceptor 的 GUC 事务上下文，自动遵循组织隔离；
 * 鉴权由控制器上的 Roles 守卫保证。
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async getTimelineEvents(limit = 100, status?: string): Promise<TimelineEvent[]> {
    try {
      const conditions = status ? [eq(ewohEvent.status, status)] : [];
      const rows = await this.db
        .select()
        .from(ewohEvent)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohEvent.createdAt))
        .limit(limit);
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
