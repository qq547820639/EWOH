import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { DeadLetterService, type RecordDeadLetterInput } from './dead-letter.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Dead Letter API（ADR-024 / NO-11a，§20 Reliability）。
 *
 *  - POST   /api/reliability/dead-letters               落账（契约 fail-closed）
 *  - GET    /api/reliability/dead-letters               台账列表（租户作用域）
 *  - POST   /api/reliability/dead-letters/:letterId/requeue  人审重放（attempts+1）
 *  - POST   /api/reliability/dead-letters/:letterId/discard  丢弃（必带理由）
 *
 * v1 禁止自动重试（requeue 仅人审触发，§2）；读写带租户上下文 + DB 层 RLS
 * （standalone_043 dead_letter_org_isolation）双保险。
 */
@Controller('api/reliability/dead-letters')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class DeadLetterController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Post()
  record(
    @Body() body: RecordDeadLetterInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.deadLetterService.record(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('sourceId') sourceId: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.deadLetterService.listLetters(this.currentOrgId(request), { status, sourceId });
  }

  @Post(':letterId/requeue')
  requeue(
    @Param('letterId') letterId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.deadLetterService.requeue(this.currentOrgId(request), letterId);
  }

  @Post(':letterId/discard')
  discard(
    @Param('letterId') letterId: string,
    @Body() body: { reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.deadLetterService.discard(
      this.currentOrgId(request),
      letterId,
      body?.reason ?? '',
    );
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: dead letter operations require tenant context');
    }
    return orgId;
  }
}
