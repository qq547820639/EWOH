import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohEvent,
  ewohLearningProposal,
  ewohNotification,
} from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * "现在需要我做什么"聚合（2026-09-13，FR6 交互愿景落地）。
 *
 * 为什么单独一个端点而不是让前端拼 5 个查询：班组长开机第一眼的问题是
 * "现在有什么要我处理的"——答案散落在异常/审批/通知/物料四个域里，
 * 前端拼装意味着 4 次请求 + 4 套优先级排序逻辑 + 4 份"读失败伪装成 0"的风险。
 * 后端一次聚合、统一优先级排序，前端只渲染——"开机即知"的地基。
 *
 * 优先级语义（从高到低）：
 *   1. critical 开异常（安全/质量红灯）
 *   2. high 开异常
 *   3. 严重级未读通知（积压待处置的）
 *
 * 范围裁决（2026-09-13）：待审批已有独立入口（审批控制台 + 顶栏收件箱）、
 * 物料缺口已有班次工作台面板、逾期行动项已有专门 sweep——这些域已有各自的
 * "叫人"机制，不需要重复聚合（重复聚合 = 同一件事叫两次 = 狼来了）。
 * 本端点聚合的是**目前没有独立叫人机制的域**：开异常 + 严重级通知。
 *
 * 每一条都带 kind / ref / route——聚合不造新事实，只是已有事实的优先级索引。
 */

export interface NowItem {
  kind: 'anomaly' | 'approval' | 'notification';
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  ref: string;
  /** 处置页路由（前端据此跳转，聚合不造路由） */
  route: string;
  severity: string | null;
  createdAt: string;
}

@Injectable()
export class WorkbenchNowService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getNow(actor?: OrgContext): Promise<{
    items: NowItem[];
    generatedAt: string;
  }> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：工作台聚合必须带租户上下文');
    }

    const [anomalies, notifications] = await Promise.all([
      this.readOpenAnomalies(orgId),
      this.readCriticalNotifications(orgId),
    ]);

    const items: NowItem[] = [
      ...anomalies.map((r) => ({
        kind: 'anomaly' as const,
        priority: (r.severity === 'critical' ? 1 : 2) as 1 | 2,
        title: r.title ?? `设备异常 ${r.deviceId ?? ''}`,
        ref: r.eventId,
        route: '/alerts',
        severity: r.severity,
        createdAt: r.createdAt,
      })),
      ...notifications.map((n) => ({
        kind: 'notification' as const,
        priority: 4 as const,
        title: n.title,
        ref: n.notificationId,
        route: '/field-operations',
        severity: n.severity,
        createdAt: n.createdAt,
      })),
    ];

    items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    return { items, generatedAt: new Date().toISOString() };
  }

  private async readOpenAnomalies(orgId: string): Promise<Array<{
    eventId: string;
    title: string | null;
    deviceId: string | null;
    severity: string;
    createdAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT event_id, title, device_id, severity, created_at
        FROM ewoh_event
       WHERE org_id = ${orgId}
         AND event_type IN (
           'AndonRaised',
           'DeviceOffline',
           'QualityFindingDetected',
           'DeviceLowBattery',
           'WorkerHighLoad',
           'WorkerPostureRisk',
           'DataDegraded'
         )
         AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 20
    `)) as unknown as Array<{
      event_id: string;
      title: string | null;
      device_id: string | null;
      severity: string;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      eventId: String(r.event_id),
      title: r.title,
      deviceId: r.device_id,
      severity: r.severity ?? 'medium',
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  private async readCriticalNotifications(orgId: string): Promise<Array<{
    notificationId: string;
    title: string;
    severity: string;
    createdAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT notification_id, title, severity, _created_at AS created_at
        FROM ewoh_notification
       WHERE org_id = ${orgId}
         AND status = 'pending'
         AND severity IN ('high', 'critical')
       ORDER BY _created_at DESC
       LIMIT 20
    `)) as unknown as Array<{
      notification_id: string;
      title: string;
      severity: string;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      notificationId: String(r.notification_id),
      title: r.title,
      severity: r.severity,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }
}
