import { Controller, Get, Param, Query } from '@nestjs/common';
import { WorldService } from './world.service';
import { Roles } from '../shared/roles.decorator';

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
}
