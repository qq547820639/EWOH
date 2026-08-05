import { Controller, Get, Query } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';

@Controller('api/timeline')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get('events')
  getEvents(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.timelineService.getTimelineEvents(limitNum, status);
  }
}
