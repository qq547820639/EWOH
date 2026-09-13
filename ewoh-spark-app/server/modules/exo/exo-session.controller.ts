import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { ExoSessionService, type StartExoSessionInput } from './exo-session.service';
import { ExoSessionReminderService } from './exo-session-reminder.service';
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
 *  - POST /api/exo/sessions/reminder-sweep 主动提醒扫描（NO-37a：只写通知，不改会话）
 *
 * §7：绑定是显式、临时且可审计的 Session——终态不可复开，新绑定=新会话。
 */
@Controller('api/exo/sessions')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ExoSessionController {
  constructor(
    private readonly exoSessions: ExoSessionService,
    private readonly reminders: ExoSessionReminderService,
  ) {}

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

  /**
   * NO-37a：会话提醒扫描（幂等；班组长/安全员/管理员可手动触发，定时 worker 调用同一实现）。
   *
   * 返回"扫了多少活跃会话、超过预计结束多少、长时间未收工多少、新增/重复提醒多少、
   * 哪些佩戴者没有绑定账号（提醒发不到人）"——提醒是派生事实，绝不改变会话状态。
   */
  @Post('reminder-sweep')
  @HttpCode(200)
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  reminderSweep(@Req() request: { userContext?: OrgContext }) {
    return this.reminders.sweep(request.userContext);
  }

  /**
   * NO-38a：会话偏差聚合（"预计 vs 实际"的运行记忆）。
   *
   * 只读、租户作用域；`windowDays`（默认 30，上限 365）与 `groupBy`（device|person）
   * 由服务端规范化。低于可比样本门槛时**不给比率**（返回 null + 说明），
   * 缺时间戳的会话计入不可比——绝不把"没记录"读成"准时"。
   */
  @Get('deviation-summary')
  deviationSummary(
    @Query('days') days: string | undefined,
    @Query('groupBy') groupBy: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.summarizeDeviations(this.currentOrgId(request), {
      windowDays: days === undefined || days === '' ? undefined : Number(days),
      groupBy: groupBy === 'person' ? 'person' : groupBy === 'device' ? 'device' : undefined,
    });
  }

  /**
   * NO-40a：会话开始的设备上下文（只读）。
   *
   * 页面在选定设备/人员后调用：返回该设备的在飞任务、当前会话与一条"可执行建议"
   * （唯一在飞任务才建议绑定；其计划结束时间可继承为预计结束，提升偏差可比性）。
   * 多任务时**不给建议**——绑定哪张任务是人的决定。
   */
  /**
   * NO-41a：活跃会话的佩戴事实双源一致性（会话 × 遥测）。
   *
   * 只读：返回每条活跃会话的判定（一致 / 佩戴人不符 / 仅证明有人在用 / 疑似未佩戴 /
   * 证据过期 / 无遥测）与逐条理由。缺遥测**不是**"没在戴"——页面照原样展示。
   */
  @Get('consistency')
  consistency(@Req() request: { userContext?: OrgContext }) {
    return this.exoSessions.listTelemetryConsistency(this.currentOrgId(request));
  }

  @Get('device-context')
  deviceContext(
    @Query('exoId') exoId: string | undefined,
    @Query('personId') personId: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.getDeviceContext(this.currentOrgId(request), exoId ?? '', personId ?? null);
  }

  @Get(':sessionId')
  get(
    @Param('sessionId') sessionId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.getSession(this.currentOrgId(request), sessionId);
  }

  /**
   * NO-43a：按实际佩戴人更正会话（遥测冲突的一步处置）。
   *
   * 同一事务内：结束旧会话（写明理由）→ 锁设备行 → 复查执行边界 → 以新佩戴人开始新会话。
   * 半成品状态（旧会话已结束、新会话没开起来）在平台侧是不允许出现的。
   *
   * 权限：**比 end/abort 更严**——收工只终结自己的事实，而更正会**替另一个人**建立
   * "正在佩戴"的事实（影响其资格判定、派工边界与偏差统计）。因此只允许班组长/安全员/
   * 管理员执行；现场人员仍可自由收工/中止自己的会话，需要改人时找班组长。
   */
  @Post(':sessionId/correct-wearer')
  @Roles('workshop_lead', 'safety_admin', 'global_admin')
  correctWearer(
    @Param('sessionId') sessionId: string,
    @Body() body: { personId?: string; endedBy?: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.exoSessions.correctWearer(
      this.currentOrgId(request),
      sessionId,
      {
        personId: body?.personId ?? '',
        ...(body?.endedBy ? { endedBy: body.endedBy } : {}),
        ...(body?.reason ? { reason: body.reason } : {}),
      },
      request.userContext,
    );
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
