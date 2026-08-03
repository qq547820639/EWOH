import { Controller, Get, Query } from '@nestjs/common';
import { TracingService } from './tracing.service';
import { Roles } from '../shared/roles.decorator';

@Controller('api/observability/traces')
@Roles('global_admin', 'safety_admin')
export class TracingController {
  constructor(private readonly tracingService: TracingService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.tracingService.list(limit ? Number(limit) : 100);
  }
}
