import { Body, Controller, Get, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { OutcomeAnnotationService, type CreateOutcomeAnnotationInput } from './outcome-annotation.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Outcome Annotation API（ADR-034 / §10 Level 7 + §12：真值标注面）。
 *
 *  - POST /api/learning/annotations             记录结果标注（契约 fail-closed + 幂等）
 *  - GET  /api/learning/annotations?targetType=&targetId=  按目标查标注
 *  - GET  /api/learning/annotations/recent     最近标注（org 作用域，可按 outcomeKind 过滤）
 *
 * 读写带租户上下文 + DB 层 RLS（standalone_047）双保险。
 */
@Controller('api/learning/annotations')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class OutcomeAnnotationController {
  constructor(private readonly annotations: OutcomeAnnotationService) {}

  @Post()
  create(
    @Body() body: CreateOutcomeAnnotationInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.annotations.create(body, this.currentOrgId(request));
  }

  @Get('recent')
  recent(
    @Query('outcomeKind') outcomeKind: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.annotations.listRecent(this.currentOrgId(request), { outcomeKind });
  }

  @Get()
  byTarget(
    @Query('targetType') targetType: string | undefined,
    @Query('targetId') targetId: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!targetType || !targetId) {
      throw new BadRequestException('targetType 与 targetId 必填（按目标查询标注）');
    }
    return this.annotations.listByTarget(this.currentOrgId(request), targetType, targetId);
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: outcome annotation operations require tenant context');
    }
    return orgId;
  }
}
