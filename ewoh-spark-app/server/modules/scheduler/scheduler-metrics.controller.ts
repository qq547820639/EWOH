import { Controller, Get, Header } from '@nestjs/common';
import { SchedulerMetricsService } from './scheduler-metrics.service';

/**
 * 调度可观测指标端点（Phase 3.2）。
 *
 * 独立于受保护的 SchedulerController，提供 Prometheus text 指标输出：
 *   GET /api/scheduler/metrics
 *
 * 该端点只读渲染 SchedulerMetricsService 的内存指标，不触碰任何受保护文件。
 */
@Controller('api/scheduler/metrics')
export class SchedulerMetricsController {
  constructor(private readonly metricsSvc: SchedulerMetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return this.metricsSvc.renderMetrics();
  }
}