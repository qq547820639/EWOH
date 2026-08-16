import { Module } from '@nestjs/common';
import { SlowQueryController } from './slow-query.controller';
import { FrontendMetricsController } from './frontend-metrics.controller';
import { FrontendMetricsService } from './frontend-metrics.service';
import { MetricsExportService } from './metrics-export.service';
import { MetricsExportController } from './metrics-export.controller';
import { EdgeMetricsService } from './edge-metrics.service';
import { MetricsModule } from '../metrics/metrics.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { AgentModule } from '../agent/agent.module';

/**
 * Observability 模块（ADR-023 / NO-10b，§19 指标腿）：统一指标导出面
 * （JSON + Prometheus 兼容，registry-validated + violations 显式）；
 * 数据源 = MetricsModule（http/db）+ SchedulerModule（scheduler 指标）+
 * AgentModule（agent 指标）。
 */
@Module({
  imports: [MetricsModule, SchedulerModule, AgentModule],
  controllers: [SlowQueryController, FrontendMetricsController, MetricsExportController],
  // SlowQueryService is provided/exported by shared.module; only the new
  // frontend-metrics service is added here.
  providers: [FrontendMetricsService, MetricsExportService, EdgeMetricsService],
  exports: [FrontendMetricsService, MetricsExportService, EdgeMetricsService],
})
export class ObservabilityModule {}
