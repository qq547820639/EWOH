import { Controller, Get, Header } from '@nestjs/common';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import type {
  SchedulingFeedback,
  SchedulingFeedbackKpis,
} from '@shared/api.interface';

/**
 * 调度可观测指标端点（Phase 3.2 / Task 7）。
 *
 * 独立于受保护的 SchedulerController，提供 Prometheus text 指标输出：
 *   GET /api/scheduler/metrics
 * 以及由 ewoh_scheduling_feedback 派生的调度 KPI（离线评估）：
 *   GET /api/scheduler/metrics/feedback          → derived KPIs
 *   GET /api/scheduler/metrics/feedback/rows     → raw feedback rows
 *
 * 该端点只读，不触碰任何受保护文件，也不修改任何调度规则。
 */
@Controller('api/scheduler/metrics')
export class SchedulerMetricsController {
  constructor(
    private readonly metricsSvc: SchedulerMetricsService,
    private readonly feedbackSvc: SchedulingFeedbackService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return this.metricsSvc.renderMetrics();
  }

  /** 由反馈表派生的调度 KPI（acceptanceRate / overrideRate / fallbackRate / solverRuntime）。 */
  @Get('feedback')
  feedback(): Promise<SchedulingFeedbackKpis> {
    return this.feedbackSvc.deriveKpis();
  }

  /** 全部反馈行（离线评估视图）。 */
  @Get('feedback/rows')
  feedbackRows(): Promise<SchedulingFeedback[]> {
    return this.feedbackSvc.list();
  }
}