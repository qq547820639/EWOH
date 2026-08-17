import { Controller, Get, Query, Req } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/timeline')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get('events')
  getEvents(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-623：limit 解析防御（NaN 回退默认 100，服务端钳制上限 500）。
    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    const limitNum = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
    return this.timelineService.getTimelineEvents(limitNum, status, request?.userContext);
  }
}
