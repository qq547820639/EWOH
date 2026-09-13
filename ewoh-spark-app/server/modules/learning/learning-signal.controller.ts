import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { LearningSignalService, type PromoteSignalInput } from './learning-signal.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 运行记忆信号 API（NO-54a 学习回路接线）。
 *
 *  - POST /api/learning/signals/scan                 扫运行记忆 → 派生/刷新信号（幂等）
 *  - GET  /api/learning/signals                      信号列表（租户作用域）
 *  - POST /api/learning/signals/:signalId/promote    人点"生成提案"（目标值由人给）
 *  - POST /api/learning/signals/:signalId/dismiss    人点"忽略"（理由必填）
 *
 * 边界（与 `shared/learning-signal.ts` 同源）：
 *   · **信号 ≠ 提案**：扫描只写 `ewoh_learning_signal`；promote 才创建提案，
 *     并进既有的影子评估 → 人审激活阶梯（§2：策略激活一律人审）；
 *   · **扫描只读业务事实**：不改告警/偏差/提醒，只写信号与审计；
 *   · 写操作收窄到班组长/安全员/管理员；读开放给全部已认证用户。
 */
@Controller('api/learning/signals')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class LearningSignalController {
  constructor(private readonly signalService: LearningSignalService) {}

  @Post('scan')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  scan(
    @Body() body: { windowDays?: number } = {},
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.signalService.scan(request.userContext, { windowDays: body?.windowDays });
  }

  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.signalService.list(request.userContext, {
      kind,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post(':signalId/promote')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  promote(
    @Param('signalId') signalId: string,
    @Body() body: PromoteSignalInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.signalService.promote(signalId, body, request.userContext);
  }

  @Post(':signalId/dismiss')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  dismiss(
    @Param('signalId') signalId: string,
    @Body() body: { reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.signalService.dismiss(signalId, body ?? {}, request.userContext);
  }
}
