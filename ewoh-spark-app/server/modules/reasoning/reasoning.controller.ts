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

  @Get('rules')
  rules() {
    return this.reasoningService.listRules();
  }
}
