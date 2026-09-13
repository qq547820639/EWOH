import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ImprovementActionService, type AcceptActionInput } from './improvement-action.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 改进行动项 API（NO-55a 学习回路接线第二轮）。
 *
 *  - POST /api/learning/actions/scan               扫已发布复盘 → 派生/刷新行动项（幂等）
 *  - GET  /api/learning/actions                    行动项列表（可按状态/优先级/负责人过滤）
 *  - GET  /api/learning/actions/overdue            逾期待办（到期已过且未完成）
 *  - GET  /api/learning/actions/:actionId/effect   复发度量（完成前后各一窗口的偏差计数；无归属则不可度量）
 *  - POST /api/learning/actions/overdue-sweep      逾期主动叫人（确定性提醒：负责人账号 + 班组长）
 *  - POST /api/learning/actions/:actionId/accept   人接受（负责人+期限+验收判据必填）
 *  - POST /api/learning/actions/:actionId/complete 人完成（结果说明必填）
 *  - POST /api/learning/actions/:actionId/decision 拒绝/放弃（理由必填）
 *
 * 边界：扫描**只读复盘记录**；接受/完成/拒绝全部需要人给足事实，
 * 平台不替现场承诺期限、不替现场宣布做完（原则 4/6/7）。
 */
@Controller('api/learning/actions')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ImprovementActionController {
  constructor(private readonly service: ImprovementActionService) {}

  @Post('scan')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  scan(
    @Body() body: { retrospectiveIds?: string[] } = {},
    @Req() request: { userContext?: OrgContext },
  ) {
    // 聚焦扫描：只扫指定复盘（页面「从这篇复盘生成行动项」/场景验证用）。
    return this.service.scan(request.userContext, { retrospectiveIds: body?.retrospectiveIds });
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('priority') priority: string | undefined,
    @Query('owner') owner: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.list(request.userContext, {
      status,
      priority,
      owner,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('overdue-sweep')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  sweepOverdue(@Req() request: { userContext?: OrgContext }) {
    // 逾期主动叫人：只读行动项，只写提醒与审计（不改状态、不代替人完成）。
    return this.service.sweepOverdue(request.userContext);
  }

  @Get(':actionId/effect')
  effect(
    @Param('actionId') actionId: string,
    @Query('windowDays') windowDays: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    // 复发度量：没有对象归属就不给结论（不硬算），样本不足也不给结论。
    return this.service.effect(actionId, request.userContext, {
      windowDays: windowDays ? Number(windowDays) : undefined,
    });
  }

  @Get('overdue')
  overdue(@Req() request: { userContext?: OrgContext }) {
    return this.service.overdue(request.userContext);
  }

  @Post(':actionId/accept')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  accept(
    @Param('actionId') actionId: string,
    @Body() body: AcceptActionInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.accept(actionId, body ?? {}, request.userContext);
  }

  @Post(':actionId/complete')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  complete(
    @Param('actionId') actionId: string,
    @Body() body: { outcomeNote?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.complete(actionId, body ?? {}, request.userContext);
  }

  @Post(':actionId/decision')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  decide(
    @Param('actionId') actionId: string,
    @Body() body: { decision?: 'rejected' | 'dropped'; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.decide(
      actionId,
      { decision: body?.decision as 'rejected' | 'dropped', reason: body?.reason },
      request.userContext,
    );
  }
}
