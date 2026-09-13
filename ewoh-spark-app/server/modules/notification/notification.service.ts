import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { ewohNotification } from '@server/database/schema';
import {
  summarizeNotificationDisposition,
  type NotificationGovernanceSummary,
} from '@shared/notification-metrics';

/**
 * NotificationService（ADR-030 / NO-12f，§17 操作台通知闭环）。
 *
 * - in-app 通知读写闭环：GET /api/notifications（租户 + 角色作用域）+
 *   POST /api/notifications/:id/read（标记已读，乐观更新）；
 * - 作用域：本租户且（recipient_type='role' 且 recipient_id ∈ 调用者
 *   角色集合；global_admin 可见全部角色通知）——他租户通知绝不可见
 *   （§15，与 DB org_id 过滤双保险）；
 * - 通知是派生事实（指向 approval/andon 等主事实的 externalRef），
 *   读写失败显式抛错/留痕，绝不静默吞。
 */
/**
 * NO-32a：通知可见范围（纯函数，便于测试与复用）。
 *
 * 规则：
 *   · global_admin → `all`（仍受 org_id 过滤，跨租户不可见）；
 *   · 有角色 → `role+user`（角色通知 ∪ **点名给自己**的通知）；
 *   · 只有用户 id → `user`（点名给自己的通知）；
 *   · 两者都没有 → `none`（fail-closed：不猜任何通知可见）。
 */
export function resolveNotificationScope(filter: {
  role?: string;
  roles?: string[];
  userId?: string;
  isGlobalAdmin?: boolean;
}): { kind: 'all' } | { kind: 'role+user'; roles: string[]; userId: string } | { kind: 'user'; userId: string } | { kind: 'none' } {
  if (filter.isGlobalAdmin) return { kind: 'all' };
  const roles = [
    ...new Set(
      [...(filter.roles ?? []), ...(filter.role ? [filter.role] : [])]
        .map((r) => r?.trim())
        .filter((r): r is string => !!r),
    ),
  ];
  const userId = filter.userId?.trim() ?? '';
  if (roles.length > 0 && userId) return { kind: 'role+user', roles, userId };
  if (roles.length > 0) return { kind: 'role+user', roles, userId: '' };
  if (userId) return { kind: 'user', userId };
  return { kind: 'none' };
}

/**
 * 写侧归属校验（与 listNotifications 同一条可见性边界）。
 *
 * 为什么需要：修复前 markRead/retryPush 只按 org 过滤——同租户任意已认证
 * 用户可以把**别人的**待办（点名给同事的、发给别的角色的安灯/SLA/审批提醒）
 * 标记已读，等于能静默压制别人的操作提醒；列表按作用域收紧了，写侧没收紧，
 * 攻破"度量不能比明细看得更多"的同一条边界（NO-46a）。规则：能"看到"
 * （resolveNotificationScope 命中）才有资格"动"；不可见 → 与不存在同语义
 * 404（反枚举，不泄露存在性）。actor 缺省（系统内部流，无 HTTP 调用方）
 * 放行——与 assertTenantVisible 同一 idioms。
 */
export function notificationAccessibleByActor(
  row: { recipientType: string; recipientId: string },
  actor?: { roles?: string[]; userId?: string; isGlobalAdmin?: boolean },
): boolean {
  if (actor === undefined) return true;
  const scope = resolveNotificationScope(actor);
  if (scope.kind === 'all') return true;
  if (scope.kind === 'role+user') {
    if (row.recipientType === 'role') return scope.roles.includes(row.recipientId);
    if (row.recipientType === 'user') return scope.userId !== '' && row.recipientId === scope.userId;
    return false;
  }
  if (scope.kind === 'user') {
    return row.recipientType === 'user' && row.recipientId === scope.userId;
  }
  // none（无角色且无用户上下文）与未登记的 recipientType：不放行（fail-closed，不猜）
  return false;
}

@Injectable()
export class NotificationService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async listNotifications(
    orgId: string,
    filter: {
      status?: string;
      role?: string;
      roles?: string[];
      /** NO-32a：调用者用户 id——用于"点名到人"的通知（如授权到期提醒给发起人）。 */
      userId?: string;
      isGlobalAdmin?: boolean;
    },
  ): Promise<unknown[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：通知查询必须带租户上下文');
    }
    const conditions = [eq(ewohNotification.orgId, orgId)];
    if (filter.status === 'pending') {
      conditions.push(eq(ewohNotification.status, 'pending'));
    } else if (filter.status === 'read') {
      conditions.push(eq(ewohNotification.status, 'read'));
    } else if (filter.status === 'resolved') {
      // NO-44a：已处置（主事实被收工/中止/更正后随之关闭）——可单独查，
      // 也仍然出现在不带 status 的全量列表里（不静默消失）。
      conditions.push(eq(ewohNotification.status, 'resolved'));
    } else if (filter.status && filter.status !== 'all') {
      // 未登记的状态值不静默按"全部"处理（原则 7：不把未知当已知）
      conditions.push(eq(ewohNotification.status, filter.status));
    }
    // R2-SNZ-002：AccessTokenGuard 只填 roles 数组（无 role 单值），原先读取 role
    // 单值恒 undefined → '__none__' 分支 → 普通用户通知恒空。
    // NO-32a：在角色通知之外，**点名到人**的通知（recipientType='user' 且就是本人）
    // 也必须可见——否则"授权到期提醒发给发起人"这类通知写了却永远读不到。
    // 安全边界：只放宽到**调用者自己的 id**（他租户仍由 org_id 过滤，他人通知看不到）。
    const scope = resolveNotificationScope(filter);
    if (scope.kind === 'role+user') {
      const roleCondition = and(
        eq(ewohNotification.recipientType, 'role'),
        inArray(ewohNotification.recipientId, scope.roles),
      );
      const userCondition = and(
        eq(ewohNotification.recipientType, 'user'),
        eq(ewohNotification.recipientId, scope.userId),
      );
      conditions.push(scope.userId ? or(roleCondition, userCondition)! : roleCondition!);
    } else if (scope.kind === 'user') {
      conditions.push(
        and(
          eq(ewohNotification.recipientType, 'user'),
          eq(ewohNotification.recipientId, scope.userId),
        )!,
      );
    } else if (scope.kind === 'none') {
      // 无角色且无用户上下文：不可见任何通知（fail-closed，不猜）
      conditions.push(eq(ewohNotification.recipientId, '__none__'));
    }
    const rows = await this.db
      .select()
      .from(ewohNotification)
      .where(and(...conditions))
      .orderBy(desc(ewohNotification.createdAt))
      .limit(200);
    return rows.map((r) => this.toNotification(r));
  }

  /**
   * NO-46a：提醒治理与处置度量（只读，运行记忆）。
   *
   * 作用域与 `listNotifications` **完全一致**（租户 + 角色/点名到人 + global 全量）：
   * 度量不能比明细看得更多，否则"我看到的数字"和"我能处理的提醒"对不上。
   *
   * 取数：按**创建时间**窗口（默认 30 天，上限 365），行数上限 2000 并如实标记
   * `truncated`——超过上限时结论只覆盖已取到的行，绝不假装是全体。
   * 聚合本身是共享纯函数（客户端同源），这里只负责取数与口径参数。
   */
  async dispositionMetrics(
    orgId: string,
    filter: {
      roles?: string[];
      userId?: string;
      isGlobalAdmin?: boolean;
    },
    options: { windowDays?: number; now?: Date } = {},
  ): Promise<NotificationGovernanceSummary> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：提醒治理度量必须带租户上下文');
    }
    const requested = Number(options.windowDays);
    const windowDays = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 365) : 30;
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const conditions = [eq(ewohNotification.orgId, orgId), gte(ewohNotification.createdAt, since)];
    const scope = resolveNotificationScope(filter);
    if (scope.kind === 'role+user') {
      const roleCondition = and(
        eq(ewohNotification.recipientType, 'role'),
        inArray(ewohNotification.recipientId, scope.roles),
      );
      const userCondition = and(
        eq(ewohNotification.recipientType, 'user'),
        eq(ewohNotification.recipientId, scope.userId),
      );
      conditions.push(scope.userId ? or(roleCondition, userCondition)! : roleCondition!);
    } else if (scope.kind === 'user') {
      conditions.push(
        and(eq(ewohNotification.recipientType, 'user'), eq(ewohNotification.recipientId, scope.userId))!,
      );
    } else if (scope.kind === 'none') {
      // 无角色且无用户上下文：与列表一致 fail-closed（看不到任何提醒 → 度量也为空）
      conditions.push(eq(ewohNotification.recipientId, '__none__'));
    }

    const limit = 2000;
    const rows = await this.db
      .select()
      .from(ewohNotification)
      .where(and(...conditions))
      .orderBy(desc(ewohNotification.createdAt))
      .limit(limit);

    const summary = summarizeNotificationDisposition(
      rows.map((row) => ({
        notificationId: row.notificationId,
        status: row.status,
        channel: row.channel,
        externalRef: row.externalRef,
        resolution: row.resolution,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      })),
      { now, windowDays },
    );
    return { ...summary, truncated: rows.length >= limit };
  }

  async markRead(
    orgId: string,
    notificationId: string,
    actor?: { roles?: string[]; userId?: string; isGlobalAdmin?: boolean },
  ): Promise<unknown> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：通知操作必须带租户上下文');
    }
    const [row] = await this.db
      .select()
      .from(ewohNotification)
      .where(and(
        eq(ewohNotification.orgId, orgId),
        eq(ewohNotification.notificationId, notificationId),
      ))
      .limit(1);
    if (!row) {
      throw new NotFoundException('notification_not_found（不存在或非本租户）');
    }
    // 写侧归属：不能动别人的通知（不可见与不存在同语义，反枚举）
    if (!notificationAccessibleByActor(row, actor)) {
      throw new NotFoundException('notification_not_found（不存在或非本租户）');
    }
    if (row.status === 'read') {
      return this.toNotification(row); // 幂等：已读重复标记不报错
    }
    if (row.status === 'resolved') {
      // NO-44a：已处置是比"已读"更强的终态——人点"标记已读"不能把它降级
      // （否则"这件事按哪次处置了结"的信息会被 read 覆盖，审计断链）。
      return this.toNotification(row);
    }
    const [updated] = await this.db
      .update(ewohNotification)
      .set({ status: 'read', readAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(ewohNotification.orgId, orgId),
        eq(ewohNotification.notificationId, notificationId),
        eq(ewohNotification.status, 'pending'),
      ))
      .returning();
    if (!updated) {
      // 并发已读：回读最新（乐观语义，不抛冲突）
      const [latest] = await this.db
        .select()
        .from(ewohNotification)
        .where(and(
          eq(ewohNotification.orgId, orgId),
          eq(ewohNotification.notificationId, notificationId),
        ))
        .limit(1);
      return this.toNotification(latest ?? row);
    }
    return this.toNotification(updated);
  }

  /**
   * 推送通知人工重试（R-58 / ADR-037）：failed → pending（派发器下次 tick
   * 重新投递）。仅推送渠道（channel ∈ PUSH_CHANNELS）且 failed 状态可重试；
   * app 通知/非 failed 状态显式拒绝（§33 不静默）。
   */
  async retryPush(
    orgId: string,
    notificationId: string,
    actor?: { roles?: string[]; userId?: string; isGlobalAdmin?: boolean },
  ): Promise<unknown> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：通知操作必须带租户上下文');
    }
    const [row] = await this.db
      .select()
      .from(ewohNotification)
      .where(and(
        eq(ewohNotification.orgId, orgId),
        eq(ewohNotification.notificationId, notificationId),
      ))
      .limit(1);
    if (!row) {
      throw new NotFoundException('notification_not_found（不存在或非本租户）');
    }
    // 写侧归属：与 markRead 同一边界（能看见才有资格重试）
    if (!notificationAccessibleByActor(row, actor)) {
      throw new NotFoundException('notification_not_found（不存在或非本租户）');
    }
    if (row.channel === 'app') {
      throw new BadRequestException('app 通知无需重试（仅推送渠道支持）');
    }
    if (row.status !== 'failed') {
      throw new BadRequestException(`仅 failed 通知可重试（当前 ${row.status}）`);
    }
    const [updated] = await this.db
      .update(ewohNotification)
      .set({ status: 'pending', errorMessage: null, updatedAt: new Date() })
      .where(and(
        eq(ewohNotification.orgId, orgId),
        eq(ewohNotification.notificationId, notificationId),
        eq(ewohNotification.status, 'failed'),
      ))
      .returning();
    if (!updated) {
      const [latest] = await this.db
        .select()
        .from(ewohNotification)
        .where(and(
          eq(ewohNotification.orgId, orgId),
          eq(ewohNotification.notificationId, notificationId),
        ))
        .limit(1);
      return this.toNotification(latest ?? row);
    }
    return this.toNotification(updated);
  }

  private toNotification(row: typeof ewohNotification.$inferSelect): Record<string, unknown> {
    return {
      notificationId: row.notificationId,
      recipientType: row.recipientType,
      recipientId: row.recipientId,
      channel: row.channel,
      title: row.title,
      body: row.body,
      severity: row.severity,
      status: row.status,
      externalRef: row.externalRef,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      errorMessage: row.errorMessage ?? null,
      // NO-44a：处置结果（NULL = 未被处置关闭；`read` 与"已处置"是两件事）
      resolution: row.resolution ?? null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolvedBy: row.resolvedBy ?? null,
      resolutionRef: row.resolutionRef ?? null,
    };
  }
}
