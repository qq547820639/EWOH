import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { DataQualityService } from './data-quality.service';
import { DataQualityNotificationService } from './data-quality-notification.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';
import type { DataQualityVerdict } from '@shared/data-quality-confirmation';

/**
 * 数据质量人工确认 API（standalone_076，DR-4 闭环第②步）。
 *
 *  - POST /api/data-quality/confirmations   登记/改判确认（confirmed|contested）
 *  - GET  /api/data-quality/confirmations?eventIds=a,b,c  批量查确认状态
 *
 * 判定人取服务端会话（不信任客户端自报身份）；confirmed 联动 resolve
 * 同源 open DataQualityAlert，contested 保持告警可见。
 */
@Controller('api/data-quality')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class DataQualityController {
  constructor(
    private readonly dataQualityService: DataQualityService,
    private readonly dataQualityNotifications: DataQualityNotificationService,
  ) {}

  /**
   * NO-53a：数据质量"待核实"提醒扫描（幂等；只读业务事实，只写提醒与审计）。
   *
   * 手动入口的价值：交接班/班次开始时班组长可以先扫一遍，把"数据不可信但没人看"的
   * 告警立刻叫到责任人（不必等下一个 worker tick）。权限收窄到班组长/安全员/管理员。
   */
  @Post('gap-sweep')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  gapSweep(@Req() request: { userContext?: OrgContext }) {
    return this.dataQualityNotifications.sweep(request.userContext);
  }

  @Post('confirmations')
  confirm(
    @Body() body: { eventId?: string; verdict?: string; note?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.eventId || (body.verdict !== 'confirmed' && body.verdict !== 'contested')) {
      throw new BadRequestException('eventId 必填；verdict 必须为 confirmed|contested');
    }
    return this.dataQualityService.confirm(
      { eventId: body.eventId, verdict: body.verdict as DataQualityVerdict, note: body.note ?? null },
      request.userContext,
    );
  }

  @Get('confirmations')
  get(
    @Query('eventIds') eventIds: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    const ids = (eventIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.dataQualityService.getConfirmations(ids, request.userContext);
  }
}
