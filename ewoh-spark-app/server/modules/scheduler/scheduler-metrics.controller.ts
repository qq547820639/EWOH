import { Controller, Get, Header, Req } from '@nestjs/common';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import type {
  SchedulingFeedback,
  SchedulingFeedbackKpis,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';

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
 * ADR-073：feedback 派生面按认证上下文 org 作用域（跨租户聚合关闭）。
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
  feedback(@Req() request?: { userContext?: OrgContext }): Promise<SchedulingFeedbackKpis> {
    return this.feedbackSvc.deriveKpis(request?.userContext?.primaryOrgId ?? null);
  }

  /** 本租户反馈行（离线评估视图；ADR-073 org 作用域）。 */
  @Get('feedback/rows')
  feedbackRows(@Req() request?: { userContext?: OrgContext }): Promise<SchedulingFeedback[]> {
    return this.feedbackSvc.list(request?.userContext?.primaryOrgId ?? null);
  }
}
