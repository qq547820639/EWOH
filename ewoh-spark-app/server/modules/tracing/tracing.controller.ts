import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
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

  /**
   * NO-10a（ADR-022）：三面缝合（spans + events（envelope correlationId）+
   * audit（request_id））——§19「从一次用户操作追踪到…」查询面。
   */
  @Get(':traceId')
  async getTrace(@Param('traceId') traceId: string) {
    if (!traceId?.trim()) {
      throw new BadRequestException('traceId 必填（HTTP traceId = §19 correlation id）');
    }
    return this.tracingService.getTrace(traceId);
  }
}
