import { Body, Controller, Get, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { IdentityService, type RegisterMappingInput } from './identity.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Identity 契约 API（ADR-006 / NO-02b）。
 * 注册/解析第三方系统 ID → EWOH 规范身份映射；所有读写带租户上下文
 * （AccessTokenGuard 注入 userContext.primaryOrgId）+ DB 层 RLS
 * （standalone_032 identity_mapping_org_isolation）双保险。
 */
@Controller('api/identity/mappings')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Post()
  register(
    @Body() body: RegisterMappingInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.identityService.registerMapping(body, this.currentOrgId(request));
  }

  @Get('resolve')
  async resolve(
    @Query('system') system: string | undefined,
    @Query('id') id: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!system || !id) {
      return { entityId: null, reason: 'system and id query params are required' };
    }
    const entityId = await this.identityService.resolveMapping(
      system,
      id,
      this.currentOrgId(request),
    );
    return { entityId, reason: entityId ? null : 'unmapped_identity' };
  }

  @Get()
  list(
    @Query('system') system: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.identityService.listMappings(this.currentOrgId(request), {
      system,
      status,
    });
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: identity operations require tenant context');
    }
    return orgId;
  }
}
