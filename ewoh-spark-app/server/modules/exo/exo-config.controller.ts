import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ExoConfigService, type RecordExoConfigInput } from './exo-config.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Exo Configuration API（ADR-051/ADR-052 / §7：外骨骼配置事实台账）。
 *
 *  - POST /api/exo/configs                记录配置事实（契约门 fail-closed + 幂等）
 *  - POST /api/exo/configs/:id/activate   激活 Assist Profile（active 唯一，旧 active 显式 supersede）
 *  - GET  /api/exo/configs                配置列表（租户作用域）
 *  - GET  /api/exo/configs/:id            配置详情（租户作用域）
 *
 * §2 边界：配置事实记录（supervisory）——绝不涉及实时助力参数下发。
 */
@Controller('api/exo/configs')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ExoConfigController {
  constructor(private readonly exoConfigs: ExoConfigService) {}

  @Post()
  record(
    @Body() body: RecordExoConfigInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoConfigs.record(body, this.currentOrgId(request));
  }

  @Post(':configId/activate')
  activate(
    @Param('configId') configId: string,
    @Body() body: { setBy?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoConfigs.activateProfile(
      this.currentOrgId(request),
      configId,
      body?.setBy ?? request.userContext?.userId ?? '',
    );
  }

  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Query('exoId') exoId: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoConfigs.listConfigs(this.currentOrgId(request), { kind, exoId, status });
  }

  @Get(':configId')
  get(
    @Param('configId') configId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoConfigs.getConfig(this.currentOrgId(request), configId);
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId;
    if (!orgId) {
      return '';
    }
    return orgId;
  }
}
