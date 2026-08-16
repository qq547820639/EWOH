import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { LearningProposalService, type ProposeLearningInput } from './learning-proposal.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Learning Proposal API（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。
 *
 *  - POST   /api/learning/proposals                提案（契约 fail-closed + 影子评估）
 *  - POST   /api/learning/proposals/:id/shadow     补做影子评估（proposed→shadow_evaluated）
 *  - POST   /api/learning/proposals/:id/approve    人审批准（§2 激活阶梯唯一入口）
 *  - POST   /api/learning/proposals/:id/reject     人审拒绝（理由必填）
 *  - POST   /api/learning/proposals/:id/rollback   人审回滚（理由必填）
 *  - GET    /api/learning/proposals                提案列表（租户作用域）
 *  - GET    /api/learning/proposals/:id            提案详情（租户作用域）
 *
 * 读写带租户上下文 + DB 层 RLS（standalone_045）双保险。不存在自动批准分支
 * （§2：策略激活一律人审，绝不隐式自动执行）。
 */
@Controller('api/learning/proposals')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class LearningProposalController {
  constructor(private readonly proposalService: LearningProposalService) {}

  @Post()
  propose(
    @Body() body: ProposeLearningInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.proposalService.propose(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.proposalService.listProposals(this.currentOrgId(request), { kind, status });
  }

  @Get(':proposalId')
  get(
    @Param('proposalId') proposalId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.proposalService.getProposal(this.currentOrgId(request), proposalId);
  }

  @Post(':proposalId/shadow')
  shadow(
    @Param('proposalId') proposalId: string,
    @Body() body: { facts?: Array<Record<string, unknown>> },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!Array.isArray(body?.facts)) {
      throw new BadRequestException('shadow 必须提供 facts 历史事实窗口');
    }
    return this.proposalService.shadow(this.currentOrgId(request), proposalId, body.facts);
  }

  @Post(':proposalId/approve')
  approve(
    @Param('proposalId') proposalId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    const approvedBy = request.userContext?.userId?.trim();
    if (!approvedBy) {
      throw new BadRequestException('approve 必须带操作者身份（userContext.userId 缺失，§2 人审阶梯 fail-closed）');
    }
    return this.proposalService.approve(this.currentOrgId(request), proposalId, approvedBy);
  }

  @Post(':proposalId/reject')
  reject(
    @Param('proposalId') proposalId: string,
    @Body() body: { reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    const rejectedBy = request.userContext?.userId?.trim();
    if (!rejectedBy) {
      throw new BadRequestException('reject 必须带操作者身份（userContext.userId 缺失）');
    }
    return this.proposalService.reject(this.currentOrgId(request), proposalId, rejectedBy, body?.reason ?? '');
  }

  @Post(':proposalId/rollback')
  rollback(
    @Param('proposalId') proposalId: string,
    @Body() body: { reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    const rolledBackBy = request.userContext?.userId?.trim();
    if (!rolledBackBy) {
      throw new BadRequestException('rollback 必须带操作者身份（userContext.userId 缺失）');
    }
    return this.proposalService.rollback(this.currentOrgId(request), proposalId, rolledBackBy, body?.reason ?? '');
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: learning proposal operations require tenant context');
    }
    return orgId;
  }
}
