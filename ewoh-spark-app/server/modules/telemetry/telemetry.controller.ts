import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { TelemetryService, type TelemetryEventInput } from './telemetry.service';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * UI 埋点上报与查询（路线图 A1）。
 *
 * 走全局 AccessTokenGuard（非 @Public）：埋点必须携带租户上下文落 org_id，
 * 且 summary 查询天然需要 org 隔离——只看本组织的指标基线。
 * 上报仍**静默失败**：任何异常都返回 accepted=0 而非 5xx，
 * 埋点绝不能在业务路径上制造错误提示。
 */
@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post('batch')
  async recordBatch(
    @Body() body: { events?: TelemetryEventInput[] },
    @Req() request: { userContext?: OrgContext },
  ): Promise<{ accepted: number }> {
    try {
      return await this.telemetryService.recordBatch(body?.events, request.userContext);
    } catch {
      // 双保险：service 已静默，这里再兜一层。
      return { accepted: 0 };
    }
  }

  /** 按事件名 + 日聚合查询（from/to 可选，默认近 30 天，clamp 366 天）。 */
  @Get('summary')
  async summary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.telemetryService.summarize(request?.userContext, { from, to });
  }
}
