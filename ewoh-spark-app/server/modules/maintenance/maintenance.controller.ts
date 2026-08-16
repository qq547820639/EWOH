import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { MaintenanceService, type CreateConditionInput, type TransitionInput } from './maintenance.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Maintenance 契约 API（ADR-010 / NO-05b）。
 * 注册/查询/转移维护状态（detected→acknowledged→work_order_created→resolved→closed）；
 * 所有读写带租户上下文（AccessTokenGuard 注入 userContext.primaryOrgId）+ DB 层 RLS
 * （standalone_034 maintenance_condition_org_isolation）双保险。
 */
@Controller('api/maintenance/conditions')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post()
  create(
    @Body() body: CreateConditionInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.maintenanceService.createCondition(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('overdue') overdue: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.maintenanceService.listConditions(this.currentOrgId(request), {
      status,
      overdue: overdue === 'true' ? true : overdue === 'false' ? false : undefined,
    });
  }

  @Post(':conditionId/transition')
  transition(
    @Param('conditionId') conditionId: string,
    @Body() body: TransitionInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.maintenanceService.transitionCondition(
      conditionId,
      body,
      this.currentOrgId(request),
    );
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: maintenance operations require tenant context');
    }
    return orgId;
  }
}
