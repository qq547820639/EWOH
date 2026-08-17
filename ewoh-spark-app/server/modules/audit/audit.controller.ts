import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AuditQueryService } from './audit.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

function clampInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

@Controller('api/audit')
@Roles('safety_admin', 'global_admin')
export class AuditController {
  constructor(private readonly auditQueryService: AuditQueryService) {}

  @Get()
  list(
    @Req() request: { userContext?: OrgContext },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('orgId') orgId?: string,
  ) {
    const ctx = request.userContext;
    const roles = ctx?.roles ?? [];
    // R2-SMI-005：应用层 org 过滤（纵深防御，不再单点依赖 RLS）——
    // 非 global_admin 强制本租户作用域（显式传入的 orgId 参数被忽略，
    // 防租户越权过滤）；org 缺失 fail-closed 401。global_admin 可显式
    // 按 orgId 过滤（缺省=全租户运维视角）。
    let effectiveOrgId: string | undefined;
    if (ctx?.isGlobalAdmin || roles.includes('global_admin')) {
      effectiveOrgId = orgId?.trim() || ctx?.primaryOrgId?.trim() || undefined;
    } else {
      effectiveOrgId = ctx?.primaryOrgId?.trim();
      if (!effectiveOrgId) {
        throw new UnauthorizedException(
          'org 上下文缺失：审计查询必须带租户上下文',
        );
      }
    }
    return this.auditQueryService.list({
      entityType: entityType || undefined,
      action: action || undefined,
      actorId: actorId || undefined,
      orgId: effectiveOrgId,
      limit: clampInteger(limit, 100, 500),
      offset: clampInteger(offset, 0, 100000),
      includeClientIp: roles.includes('safety_admin') || roles.includes('global_admin'),
    });
  }
}
