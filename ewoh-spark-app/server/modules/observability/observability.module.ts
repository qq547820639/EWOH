import { Module } from '@nestjs/common';
import { SlowQueryController } from './slow-query.controller';
import { FrontendMetricsController } from './frontend-metrics.controller';
import { FrontendMetricsService } from './frontend-metrics.service';

@Module({
  controllers: [SlowQueryController, FrontendMetricsController],
  // SlowQueryService is provided/exported by shared.module; only the new
  // frontend-metrics service is added here.
  providers: [FrontendMetricsService],
  exports: [FrontendMetricsService],
})
export class ObservabilityModule {}
