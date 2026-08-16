import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { WorkOrderService, type CreateWorkOrderInput, type TransitionWorkOrderInput } from './workorder.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * WorkOrder 契约 API（ADR-012 / NO-05e-b）。
 * 创建/查询/转移工单（created→scheduled→in_progress→completed→closed，
 * created/scheduled 可 cancelled；completed/closed 落 completedAt，cancelled 必带
 * reason）；所有读写带租户上下文（AccessTokenGuard 注入 userContext.primaryOrgId）+
 * DB 层 RLS（standalone_035 work_order_org_isolation）双保险。
 */
@Controller('api/workorders')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class WorkOrderController {
  constructor(private readonly workOrderService: WorkOrderService) {}

  @Post()
  create(
    @Body() body: CreateWorkOrderInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workOrderService.createWorkOrder(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('originKind') originKind: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workOrderService.listWorkOrders(this.currentOrgId(request), {
      status,
      originKind,
    });
  }

  @Post(':workOrderId/transition')
  transition(
    @Param('workOrderId') workOrderId: string,
    @Body() body: TransitionWorkOrderInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workOrderService.transitionWorkOrder(
      workOrderId,
      body,
      this.currentOrgId(request),
    );
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: work order operations require tenant context');
    }
    return orgId;
  }
}
