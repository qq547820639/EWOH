import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { WorldService } from './world.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/world')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class WorldController {
  constructor(private readonly worldService: WorldService) {}

  @Get('state')
  async getCurrentState() {
    return this.worldService.getCurrentState();
  }

  @Get('events/chain/:eventId')
  async getEventChain(@Param('eventId') eventId: string) {
    return this.worldService.getEventChain(eventId);
  }

  @Get('replay')
  async getReplay(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.worldService.getReplay(from, to, limitNum);
  }

  @Get('replay/context/:eventId')
  async getEventContext(
    @Param('eventId') eventId: string,
    @Query('windowMinutes') windowMinutes?: string,
  ) {
    return this.worldService.getEventContext(
      eventId,
      windowMinutes ? parseInt(windowMinutes, 10) : 10,
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
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.worldService.createReplayItem(body, request.userContext);
  }
}
