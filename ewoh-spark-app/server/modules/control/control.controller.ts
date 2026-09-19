import { Controller, Get, Post, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ControlService } from './control.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { IngestGuard } from '../ingest/ingest.guard';
import { Public } from '../shared/public.decorator';
import { Roles } from '../shared/roles.decorator';

@Controller('api/control/requests')
export class ControlController {
  constructor(private readonly controlService: ControlService) {}

  /**
   * NO-66a：设备执行边界读面（人面）——"这台设备的控制命令现在什么状态、为什么"。
   *
   * RBAC：值班/调度/班组长/安全/设备运维可见（只读）。租户隔离走服务层 org 守卫。
   * 为什么放在 `requests` 控制器而不是新控制器：命令是"请求的一个 attempt"，
   * 读面必须与写面同一租户/权限口径，拆两个控制器最容易漂移。
   */
  @Get()
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'safety_admin', 'device_ops')
  listByDevice(
    @Query('deviceId') deviceId: string,
    @Query('limit') limit?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.controlService.listDeviceCommands(
      deviceId,
      { limit: limit ? Number(limit) : undefined },
      request?.userContext,
    );
  }

  @Post()
  create(
    @Body() body: { deviceId: string; commandKeys: string[]; idempotencyKey: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.controlService.createRequest(body, request.userContext);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // ADR-077：读面 org 守卫（跨租户 404）。
    return this.controlService.getStatus(id, request?.userContext);
  }

  @Post(':id/commands')
  send(
    @Param('id') id: string,
    @Body() body: { commandKey: string; payload?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    // NO-60a：命令参数（执行机构"去哪"之类）随命令下发，落库并由边缘网关取走。
    return this.controlService.sendCommand(id, body.commandKey, request.userContext, body.payload);
  }

  @Post(':id/receipts')
  receipt(
    @Param('id') id: string,
    @Body() body: { commandKey: string; result: 'executed' | 'failed'; receipt?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-423：回执路径同样带租户上下文（应用层 org 守卫，跨租户 404）。
    return this.controlService.receiveReceipt(
      id,
      body.commandKey,
      body.result,
      body.receipt,
      request.userContext,
    );
  }

  @Post(':id/revoke')
  revoke(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (action !== 'revoke') {
      return this.controlService.getRequest(id, request.userContext);
    }
    return this.controlService.revoke(id, request.userContext);
  }
}

/**
 * NO-68a：控制命令**投递积压巡检**的人工触发面。
 *
 * 路径与其它域的巡检同构（`api/control/delivery-backlog/sweep`，对齐
 * `/api/perception/fusion/sweep`、`/api/exo/sessions/reminder-sweep`、
 * `/api/learning/actions/overdue-sweep`、`/api/approvals/authorizations/expiry-sweep`）。
 *
 * 为什么**不**挂在 `ControlController`（`api/control/requests`）下：读面
 * `GET /api/control/requests?deviceId=` 是"某台设备下命令的视图"，确实是 request 的子资源；
 * 而巡检是**跨设备/跨 request 的租户级操作**（扫全租户未交付命令），
 * 说成 `requests/delivery-backlog/sweep` 会把 URL 说成它不是的东西。
 *
 * 定时 worker 跑同一实现；这里额外开放给值班角色手动触发（现场排障不必等下一个周期）。
 * 只写提醒与审计，**不改命令/设备事实**。
 */
@Controller('api/control')
export class ControlDeliveryBacklogController {
  constructor(private readonly controlService: ControlService) {}

  /**
   * NO-77a：投递积压**实时快照**（只读）——两次巡检之间积压也必须可见、可数。
   * 判定与 sweep 同一实现；看板/工作台按它展示聚合数字。
   */
  @Get('delivery-backlog/status')
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops')
  deliveryBacklogStatus(@Req() request: { userContext: OrgContext }) {
    return this.controlService.getDeliveryBacklogSnapshot(request.userContext);
  }

  /**
   * NO-91a：积压**历史序列**（最近在前）——趋势可见，漂移早发现。
   */
  @Get('delivery-backlog/history')
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops')
  deliveryBacklogHistory(
    @Query('limit') limit?: string,
    @Req() request: { userContext: OrgContext } = { userContext: undefined as unknown as OrgContext },
  ) {
    return this.controlService.getDeliveryBacklogHistory(
      request.userContext,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('delivery-backlog/sweep')
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops')
  sweepDeliveryBacklog(@Req() request: { userContext: OrgContext }) {
    return this.controlService.sweepDeliveryBacklog(request.userContext);
  }
}

/**
 * 边缘网关命令面（NO-60a）：机器对机器，复用 IngestGuard 的密钥+租户绑定。
 *
 * - `GET  /api/control/commands/pending?deviceId=…`  取待投递命令（平台签发授权号）
 * - `POST /api/control/commands/:commandId/ack`      投递确认（gateway_received / failed）
 * - `POST /api/control/commands/:commandId/receipt`  执行结果回执（executed / failed）
 *
 * 为什么是轮询：工厂边缘常在内网/NAT 后，平台无法直连；轮询 + 幂等 ack 是能在现场
 * 落地的下行方式。**命令只能由平台签发**（授权号 = `control:<requestId>`），
 * 边缘不能凭空产生授权号——原则 4：高风险设备动作必须可追溯到授权。
 */
@Controller('api/control/commands')
@UseGuards(IngestGuard)
@Public()
export class ControlGatewayController {
  constructor(private readonly controlService: ControlService) {}

  @Get('pending')
  pending(
    @Query('deviceId') deviceId: string,
    @Query('limit') limit: string | undefined,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.controlService.listPendingCommands(
      deviceId,
      { limit: limit ? Number(limit) : undefined },
      request?.userContext,
    );
  }

  @Post(':commandId/receipt')
  receiptByCommand(
    @Param('commandId') commandId: string,
    @Body() body: { result: 'executed' | 'failed'; receipt?: Record<string, unknown> },
    @Req() request?: { userContext?: OrgContext },
  ) {
    // 机器身份（边缘网关）回执执行结果：按 commandId 定位请求/命令键，复用同一套校验
    return this.controlService.receiveReceiptByCommandId(
      commandId,
      body?.result,
      body?.receipt,
      request?.userContext,
    );
  }

  @Post(':commandId/ack')
  ack(
    @Param('commandId') commandId: string,
    @Body() body: { delivered: boolean; reason?: string; details?: Record<string, unknown> },
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.controlService.ackCommand(
      commandId,
      {
        delivered: body?.delivered === true,
        reason: body?.reason,
        details: body?.details,
      },
      request?.userContext,
    );
  }
}
