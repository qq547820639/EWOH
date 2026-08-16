import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { QualityService, type CreateFindingInput, type TransitionFindingInput } from './quality.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Quality 契约 API（ADR-010 / NO-05b）。
 * 注册/查询/转移质量发现（open→under_review→dispositioned→closed，dispositioned 必须带
 * disposition）；所有读写带租户上下文（AccessTokenGuard 注入 userContext.primaryOrgId）+
 * DB 层 RLS（standalone_034 quality_finding_org_isolation）双保险。
 */
@Controller('api/quality/findings')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Post()
  create(
    @Body() body: CreateFindingInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.qualityService.createFinding(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.qualityService.listFindings(this.currentOrgId(request), { status });
  }

  @Post(':findingId/transition')
  transition(
    @Param('findingId') findingId: string,
    @Body() body: TransitionFindingInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.qualityService.transitionFinding(
      findingId,
      body,
      this.currentOrgId(request),
    );
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: quality operations require tenant context');
    }
    return orgId;
  }
}
