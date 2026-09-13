import { Body, Controller, Get, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { LearningService, type EvaluateLearningInput } from './learning.service';
import { LearningProposalService } from './learning-proposal.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Learning API（ADR-021 / NO-09a，Phase 12 Continuous Learning Loop v1）。
 *
 *  - POST /api/learning/evaluate       评估 (org, 周期) 七项学习指标快照
 *  - GET  /api/learning/evaluations    台账列表（租户作用域）
 *  - GET  /api/learning/latest         最近一次评估
 *  - GET  /api/learning/thresholds     当前阈值基线（生效值 + 来源 + 读取时间）
 *
 * 读写带租户上下文 + DB 层 RLS（standalone_041 learning_evaluation_org_isolation）
 * 双保险。v1 观测层：绝不自动回写生产规则（§2）。
 */
@Controller('api/learning')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class LearningController {
  constructor(
    private readonly learningService: LearningService,
    private readonly proposalService: LearningProposalService,
  ) {}

  /**
   * 阈值基线读面（决策原则 5：来源 / 更新时间 / 影响面必须可解释）。
   * 只读：返回当前生效阈值及其来源（approved 提案 or 引擎内置常量），
   * 供提议者在提出受控变更前看到真实基线——不读此面就只能靠猜。
   */
  @Get('thresholds')
  thresholds(@Req() request: { userContext?: OrgContext }) {
    return this.proposalService.getThresholdBaseline(this.currentOrgId(request));
  }

  @Post('evaluate')
  evaluate(
    @Body() body: EvaluateLearningInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.learningService.evaluate(body, this.currentOrgId(request));
  }

  @Get('evaluations')
  list(@Req() request: { userContext?: OrgContext }) {
    return this.learningService.listEvaluations(this.currentOrgId(request));
  }

  @Get('latest')
  async latest(@Req() request: { userContext?: OrgContext }) {
    const evaluation = await this.learningService.latest(this.currentOrgId(request));
    if (!evaluation) {
      throw new BadRequestException('learning_evaluation_not_found（本租户无评估记录）');
    }
    return evaluation;
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: learning operations require tenant context');
    }
    return orgId;
  }
}
