import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { ExoSessionService, type StartExoSessionInput } from './exo-session.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Exo Session API（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 *  - POST /api/exo/sessions          开始会话（契约 fail-closed + 活跃冲突显式）
 *  - POST /api/exo/sessions/:id/end  正常结束（状态机 + endedBy 必填）
 *  - POST /api/exo/sessions/:id/abort 中止（状态机 + endedBy 必填）
 *  - GET  /api/exo/sessions          会话列表（租户作用域，含历史）
 *  - GET  /api/exo/sessions/:id      会话详情（租户作用域）
 *
 * §7：绑定是显式、临时且可审计的 Session——终态不可复开，新绑定=新会话。
 */
@Controller('api/exo/sessions')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ExoSessionController {
  constructor(private readonly exoSessions: ExoSessionService) {}

  @Post()
  start(
    @Body() body: StartExoSessionInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.start(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('exoId') exoId: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.listSessions(this.currentOrgId(request), { status, exoId });
  }

  @Get(':sessionId')
  get(
    @Param('sessionId') sessionId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.getSession(this.currentOrgId(request), sessionId);
  }

  @Post(':sessionId/end')
  end(
    @Param('sessionId') sessionId: string,
    @Body() body: { endedBy?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.endSession(
      this.currentOrgId(request),
      sessionId,
      body?.endedBy ?? request.userContext?.userId ?? '',
      body?.reason,
    );
  }

  @Post(':sessionId/abort')
  abort(
    @Param('sessionId') sessionId: string,
    @Body() body: { endedBy?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.abortSession(
      this.currentOrgId(request),
      sessionId,
      body?.endedBy ?? request.userContext?.userId ?? '',
      body?.reason,
    );
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: exo session operations require tenant context');
    }
    return orgId;
  }
}
