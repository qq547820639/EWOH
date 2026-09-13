import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import { NOTIFICATION_LIST_FILTERS, isNotificationListFilter } from '@shared/notification-resolution';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Notification API（ADR-030 / NO-12f，§17 通知闭环）。
 *
 *  - GET  /api/notifications               通知列表（租户 + 角色作用域）
 *  - POST /api/notifications/:id/read      标记已读（乐观 + 幂等）
 *
 * 读写带租户上下文；他租户通知绝不可见（§15）。
 */
@Controller('api/notifications')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * 通知列表。
   *
   * NO-44a：`status` 支持 `pending` / `read` / `resolved`（留空=全部）。
   * **未知取值显式 400**，不再静默降级成"全部"——实测踩过：`?status=resolved`
   * 此前被悄悄忽略、返回全部通知，调用方以为自己在查"已处置"。
   */
  @Get()
  list(
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext & { isGlobalAdmin?: boolean } },
  ) {
    const rawStatus = (status ?? '').trim();
    if (rawStatus !== '' && !isNotificationListFilter(rawStatus)) {
      throw new BadRequestException(
        `bad_notification_status:${rawStatus}（只支持 ${NOTIFICATION_LIST_FILTERS.join('/')}，留空=全部）`,
      );
    }
    return this.notifications.listNotifications(this.currentOrgId(request), {
      status: rawStatus === '' ? undefined : rawStatus,
      // R2-SNZ-002：AccessTokenGuard 填充的是 roles 数组（role 单值恒
      // undefined），此处传数组由 service 做 recipient_id ∈ roles 匹配。
      roles: request.userContext?.roles ?? [],
      // NO-32a：把调用者用户 id 一并下传——点名到人的通知（授权到期提醒给发起人）
      // 需要按 recipientType='user' + 本人 id 匹配才读得到。
      userId: request.userContext?.userId,
      isGlobalAdmin: request.userContext?.isGlobalAdmin === true,
    });
  }

  /**
   * NO-46a：提醒治理与处置度量（只读，班组长/安全员/管理员）。
   *
   * 回答管理问题：处置率与处置时长、哪些提醒反复出现、有多少被放着没人管、
   * 投递失败有没有被漏掉。作用域与通知列表一致（不放大可见范围）。
   * `days` 由服务端规范化（默认 30，1–365）。
   */
  @Get('metrics')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  metrics(
    @Query('days') days: string | undefined,
    @Req() request: { userContext?: OrgContext & { isGlobalAdmin?: boolean } },
  ) {
    return this.notifications.dispositionMetrics(
      this.currentOrgId(request),
      {
        roles: request.userContext?.roles ?? [],
        userId: request.userContext?.userId,
        isGlobalAdmin: request.userContext?.isGlobalAdmin === true,
      },
      { ...(days === undefined || days.trim() === '' ? {} : { windowDays: Number(days) }) },
    );
  }

  @Post(':id/read')
  markRead(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext & { isGlobalAdmin?: boolean } },
  ) {
    return this.notifications.markRead(this.currentOrgId(request), id, {
      // 写侧归属校验：能"看到"（与列表同作用域）才有资格标记已读——
      // 否则同租户任意用户可以静默压制别人的待办提醒。
      roles: request.userContext?.roles ?? [],
      userId: request.userContext?.userId,
      isGlobalAdmin: request.userContext?.isGlobalAdmin === true,
    });
  }

  /** 推送通知人工重试（failed → pending，R-58 / ADR-037）。 */
  @Post(':id/retry')
  @Roles('dispatcher', 'workshop_lead', 'global_admin')
  retry(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext & { isGlobalAdmin?: boolean } },
  ) {
    return this.notifications.retryPush(this.currentOrgId(request), id, {
      // 写侧归属校验（与 markRead 同一边界）。
      roles: request.userContext?.roles ?? [],
      userId: request.userContext?.userId,
      isGlobalAdmin: request.userContext?.isGlobalAdmin === true,
    });
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: notification operations require tenant context');
    }
    return orgId;
  }
}
