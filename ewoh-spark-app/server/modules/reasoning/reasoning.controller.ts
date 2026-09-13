import { Body, Controller, Get, Post, Req, BadRequestException } from '@nestjs/common';
import { ReasoningService, type EvaluateReasoningInput } from './reasoning.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 工业推理 API（ADR-020 / NO-08b，Level 4 独立工业推理层）。
 *
 *  - POST /api/reasoning/evaluate  确定性规则评估 → 轨迹契约自检 →
 *    结论逐条 L4 台账落账（InferenceResultRecorded 事件）→ trace + inferenceIds
 *  - GET  /api/reasoning/rules     规则注册表（可解释面：触发条件/严重度）
 *
 * 读写带租户上下文 + 台账 RLS（standalone_040）双保险。
 */
@Controller('api/reasoning')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ReasoningController {
  constructor(private readonly reasoningService: ReasoningService) {}

  @Post('evaluate')
  evaluate(
    @Body() body: EvaluateReasoningInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: reasoning evaluate requires tenant context');
    }
    return this.reasoningService.evaluate(body, orgId);
  }

  /**
   * NO-25a：从**实时世界模型**评估（不手供事实）。
   *
   * 读权威快照 + 最近环境读数 → 投影事实（新鲜度/置信度/能力声明三道闸）→
   * 同一套确定性规则评估与 L4 落账。响应同时给出依据（evidence）与未采用的数据
   * （skipped），现场可判断"结论为什么出现/为什么没出现"。
   */
  @Post('evaluate-live')
  evaluateLive(@Req() request: { userContext?: OrgContext }) {
    return this.reasoningService.evaluateLive(request.userContext);
  }

  /** NO-25a：只读事实视图（不评估、不落账）——排障与 AI 解释的事实来源。 */
  @Get('live-facts')
  liveFacts(@Req() request: { userContext?: OrgContext }) {
    return this.reasoningService.listLiveFacts(request.userContext);
  }

  @Get('rules')
  rules() {
    return this.reasoningService.listRules();
  }
}
