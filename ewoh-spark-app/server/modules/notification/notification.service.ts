import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohNotification } from '@server/database/schema';

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
@Injectable()
export class NotificationService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async listNotifications(
    orgId: string,
    filter: { status?: string; role?: string; isGlobalAdmin?: boolean },
  ): Promise<unknown[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：通知查询必须带租户上下文');
    }
    const conditions = [eq(ewohNotification.orgId, orgId)];
    if (filter.status === 'pending') {
      conditions.push(eq(ewohNotification.status, 'pending'));
    } else if (filter.status === 'read') {
      conditions.push(eq(ewohNotification.status, 'read'));
    }
    if (!filter.isGlobalAdmin) {
      const role = filter.role?.trim();
      if (role) {
        conditions.push(eq(ewohNotification.recipientId, role));
      } else {
        // 无角色上下文：仅本人不可见任何 role 通知（fail-closed，不猜）
        conditions.push(eq(ewohNotification.recipientId, '__none__'));
      }
    }
    const rows = await this.db
      .select()
      .from(ewohNotification)
      .where(and(...conditions))
      .orderBy(desc(ewohNotification.createdAt))
      .limit(200);
    return rows.map((r) => this.toNotification(r));
  }

  async markRead(orgId: string, notificationId: string): Promise<unknown> {
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
    if (row.status === 'read') {
      return this.toNotification(row); // 幂等：已读重复标记不报错
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
  async retryPush(orgId: string, notificationId: string): Promise<unknown> {
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
    };
  }
}
