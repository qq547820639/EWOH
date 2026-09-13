import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { PerceptionFusionService } from './perception-fusion.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 多模态感知融合 API（NO-56a，§5）。
 *
 *  - POST /api/perception/fusion/sweep   多源融合一次（幂等；只读感知事实，只写快照与审计）
 *  - GET  /api/perception/fusion         最新融合快照（默认每个主体取最新）
 *
 * 边界：融合结论**不是**控制指令——`strongAdviceAllowed=false` 时上游不得据此生成强建议
 * （§5 规则 5）；无可用源时如实返回 unknown/insufficient（不显示成 0%）。
 */
@Controller('api/perception/fusion')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class PerceptionFusionController {
  constructor(private readonly service: PerceptionFusionService) {}

  @Post('sweep')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  sweep(
    @Body() body: { windowMinutes?: number; bucketMinutes?: number } = {},
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.sweep(request.userContext, {
      windowMinutes: body?.windowMinutes,
      bucketMinutes: body?.bucketMinutes,
    });
  }

  @Get()
  list(
    @Query('subjectId') subjectId: string | undefined,
    @Query('agreement') agreement: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.list(request.userContext, {
      subjectId,
      agreement,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
