import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
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

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext & { isGlobalAdmin?: boolean } },
  ) {
    return this.notifications.listNotifications(this.currentOrgId(request), {
      status: status === 'pending' || status === 'read' ? status : undefined,
      role: request.userContext?.role,
      isGlobalAdmin: request.userContext?.isGlobalAdmin === true,
    });
  }

  @Post(':id/read')
  markRead(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.notifications.markRead(this.currentOrgId(request), id);
  }

  /** 推送通知人工重试（failed → pending，R-58 / ADR-037）。 */
  @Post(':id/retry')
  @Roles('dispatcher', 'workshop_lead', 'global_admin')
  retry(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.notifications.retryPush(this.currentOrgId(request), id);
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: notification operations require tenant context');
    }
    return orgId;
  }
}
