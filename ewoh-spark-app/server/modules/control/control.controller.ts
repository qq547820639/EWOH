import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { ControlService } from './control.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/control/requests')
export class ControlController {
  constructor(private readonly controlService: ControlService) {}

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
    @Body() body: { commandKey: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.controlService.sendCommand(id, body.commandKey, request.userContext);
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
