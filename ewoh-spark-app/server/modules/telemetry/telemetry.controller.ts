import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { TelemetryService, type TelemetryEventInput } from './telemetry.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * UI 埋点上报与查询（路线图 A1）。
 *
 * 走全局 AccessTokenGuard（非 @Public）：埋点必须携带租户上下文落 org_id，
 * 且 summary 查询天然需要 org 隔离——只看本组织的指标基线。
 * 上报仍**静默失败**：任何异常都返回 accepted=0 而非 5xx，
 * 埋点绝不能在业务路径上制造错误提示。
 *
 * 鉴权（WP-A 修复）：全局 RolesGuard 是 default-deny——此前本控制器既无
 * @Roles 也无 FALLBACK 映射，导致 /api/telemetry/batch 与 /api/telemetry/summary
 * 对**所有**登录角色恒 403；前端 api/telemetry.ts 又把失败静默吞掉，于是埋点
 * 从未落库且无人察觉。现按端点语义显式声明：
 *  - batch（上报）：所有已登录角色的 UI 埋点，登录即可写（登录 + org 绑定 +
 *    服务端白名单/限量清洗即护栏），与 FrontendMetricsController.ingest 同构；
 *  - summary（聚合读取）：管理人员/观测者只读，与 FrontendMetricsController.query
 *    及 security/access-matrix.yaml 的 command-center/alerts/audit 中心一致。
 */
@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post('batch')
  @Roles(...ANY_AUTHENTICATED_ROLES)
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
  @Roles('global_admin', 'safety_admin', 'dispatcher', 'workshop_lead')
  async summary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.telemetryService.summarize(request?.userContext, { from, to });
  }
}
