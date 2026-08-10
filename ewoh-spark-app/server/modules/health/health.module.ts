import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReplanGuardStatusService } from './replan-guard-status.service';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [MetricsModule],
  controllers: [HealthController],
  providers: [ReplanGuardStatusService],
  exports: [ReplanGuardStatusService],
})
export class HealthModule {}
