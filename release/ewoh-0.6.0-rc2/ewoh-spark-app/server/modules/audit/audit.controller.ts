import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditQueryService } from './audit.service';
import { Roles } from '../shared/roles.decorator';

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
    @Req() request: { userContext?: { roles?: string[] } },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
  ) {
    const roles = request.userContext?.roles ?? [];
    return this.auditQueryService.list({
      entityType: entityType || undefined,
      action: action || undefined,
      actorId: actorId || undefined,
      limit: clampInteger(limit, 100, 500),
      offset: clampInteger(offset, 0, 100000),
      includeClientIp: roles.includes('safety_admin') || roles.includes('global_admin'),
    });
  }
}
