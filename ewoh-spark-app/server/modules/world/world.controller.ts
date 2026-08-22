import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { WorldService } from './world.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/world')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class WorldController {
  constructor(private readonly worldService: WorldService) {}

  @Get('state')
  async getCurrentState(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : undefined;
    return this.worldService.getCurrentState(
      request?.userContext,
      Number.isFinite(pageNum) ? pageNum : undefined,
      Number.isFinite(pageSizeNum) ? pageSizeNum : undefined,
    );
  }

  @Get('events/chain/:eventId')
  async getEventChain(
    @Param('eventId') eventId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.worldService.getEventChain(eventId, request?.userContext);
  }

  @Get('replay')
  async getReplay(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.worldService.getReplay(from, to, limitNum, request?.userContext);
  }

  @Get('replay/context/:eventId')
  async getEventContext(
    @Param('eventId') eventId: string,
    @Query('windowMinutes') windowMinutes?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.worldService.getEventContext(
      eventId,
      windowMinutes ? parseInt(windowMinutes, 10) : 10,
      request?.userContext,
    );
  }

  @Post('replay/items')
  async createReplayItem(
    @Body()
    body: {
      eventId: string;
      kind: 'issue' | 'task' | 'evidence';
      title?: string;
      note?: string;
      replayTime?: string;
    },
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.worldService.createReplayItem(body, request?.userContext);
  }
}
