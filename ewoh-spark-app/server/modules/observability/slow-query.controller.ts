import { Controller, Get, Query } from '@nestjs/common';
import { SlowQueryService } from './slow-query.service';
import { Roles } from '../shared/roles.decorator';

@Controller('api/observability')
@Roles('global_admin', 'safety_admin', 'dispatcher', 'workshop_lead')
export class SlowQueryController {
  constructor(private readonly slowQueryService: SlowQueryService) {}

  @Get('slow-queries')
  list(@Query('limit') limit?: string) {
    return this.slowQueryService.list(
      limit ? parseInt(limit, 10) : 100,
    );
  }
}
