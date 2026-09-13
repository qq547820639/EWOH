import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApprovalPersistenceService } from './approval-persistence.service';
import { ApprovalExpiryService } from './approval-expiry.service';
import { Roles } from '../shared/roles.decorator';
import type { ApprovalStepAction, CreateApprovalRequest } from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 审批旁路（emergency bypass）的唯一合法角色。
 *
 * 与 approval-persistence.service.ts `bypass()` 的服务层判定同源：契约
 * contracts/state-machines/approval.yaml 的 `pending → bypassed` 迁移写死
 * role: high_privilege_admin（映射 HIGH_PRIVILEGE_ROLE = global_admin），
 * 服务层也照此拒绝其余角色（approval-persistence.service.ts:653）。
 * 控制器此前无方法级 @Roles，继承类级 FALLBACK（含 workshop_lead/safety_admin）——
 * 结果是角色面板显示"有权限"、提交后服务层 403，写面口径分裂。
 * 此处取更安全的一侧：guard 收敛到 global_admin，与服务层/契约一致。
 * （access-matrix.yaml 曾把 approval_bypass 列在 safety_admin 名下，与契约冲突，
 *  以契约 approval.yaml 为准，未在服务层放宽。）
 *
 * @internal 供回归测试断言"控制器角色集 ⊆ 服务层允许集"。
 */
export const APPROVAL_BYPASS_ROLES = ['global_admin'] as const;

@Controller('api/approvals')
export class ApprovalController {
  constructor(
    private readonly approvalService: ApprovalPersistenceService,
    private readonly approvalExpiryService: ApprovalExpiryService,
  ) {}

  @Post()
  create(
    @Body() body: CreateApprovalRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.createApproval(body, request.userContext);
  }

  /** NO-12f/ADR-030：待批清单（org 作用域）。 */
  @Get('pending')
  listPending(@Req() request: { userContext?: OrgContext }) {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: approval list requires tenant context');
    }
    return this.approvalService.listPending(orgId);
  }

  /**
   * NO-24a：执行边界授权视图（已授权 + 时效 + 消耗）。
   *
   * 与 `pending`（待批）互补：这里回答"哪些授权还能用、什么时候失效、已经用在哪"，
   * 让"已通过但已过期"不再只在实际执行时才被发现。
   */
  @Get('authorizations')
  listAuthorizations(@Req() request: { userContext?: OrgContext }) {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: authorization list requires tenant context');
    }
    return this.approvalService.listCapabilityAuthorizations(orgId);
  }

  /**
   * NO-30a：授权到期扫描（幂等；管理员/安全员可手动触发，定时 worker 也调用同一实现）。
   *
   * 返回"扫了多少、即将过期多少、已过期多少、新增提醒多少、重复跳过多少"——
   * 提醒本身是派生事实，绝不改变授权状态。
   */
  @Post('authorizations/expiry-sweep')
  @HttpCode(200)
  @Roles('safety_admin', 'global_admin')
  expirySweep(@Req() request: { userContext?: OrgContext }) {
    return this.approvalExpiryService.sweep(request.userContext);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-402：读面 org 守卫。
    return this.approvalService.getApproval(id, request.userContext);
  }

  @Post(':id/steps/:stepId/state')
  @HttpCode(200)
  step(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Query('action') action: ApprovalStepAction,
    @Body() body: { reason?: string; delegateTo?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.stepAction(
      id,
      stepId,
      action,
      body.reason,
      body.delegateTo,
      request.userContext,
    );
  }

  @Post(':id/bypass')
  @HttpCode(200)
  @Roles(...APPROVAL_BYPASS_ROLES)
  bypass(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.bypass(id, body.reason ?? '', request.userContext);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.cancel(id, request.userContext);
  }
}
