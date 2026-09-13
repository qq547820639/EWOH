import { Controller, Get, Query, Req } from '@nestjs/common';
import { PlannedVsActualService } from './planned-vs-actual.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 预计 vs 实际 对账 API（NO-57b）。
 *
 *  - GET /api/scheduler/planned-vs-actual?windowDays=30   执行事实的对账口径（只读）
 *
 * 样本不足时**不给比率**（`null` + notes）；不可比行按原因分类；缺失不当 0。
 */
@Controller('api/scheduler/planned-vs-actual')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class PlannedVsActualController {
  constructor(private readonly service: PlannedVsActualService) {}

  @Get()
  summarize(
    @Query('windowDays') windowDays: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.summarize(request.userContext, {
      windowDays: windowDays ? Number(windowDays) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
