import { Controller, Get, Header, Req } from '@nestjs/common';
import { Roles } from '../shared/roles.decorator';
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
 * NEST-139 修复（2026-08-17）：/metrics 面向运维/抓取器，显式 @Roles 限
 * global_admin（standalone 入口有全局 AccessTokenGuard；legacy 入口经
 * RolesGuard 收敛——此前无角色约束，任何已认证/未认证（legacy）调用方可抓取）。
 */
@Controller('api/scheduler/metrics')
@Roles('global_admin')
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

  /**
   * 由反馈表派生的调度 KPI（acceptanceRate / overrideRate / fallbackRate / solverRuntime）。
   * R2-SSV-26（2026-08-17）：无 primaryOrgId 的 global_admin 显式放行全局聚合
   * （scope=ALL 跨租户运维视角）；此前 NEST-108 守卫对全局管理员抛 400，
   * 鉴权已过却报缺参。非 global 管理员路径不变（本 org 作用域强制）。
   */
  @Get('feedback')
  feedback(@Req() request?: { userContext?: OrgContext }): Promise<SchedulingFeedbackKpis> {
    const ctx = request?.userContext;
    return this.feedbackSvc.deriveKpis(ctx?.primaryOrgId ?? null, {
      globalScope: Boolean(ctx?.isGlobalAdmin) && !ctx?.primaryOrgId,
    });
  }

  /** 本租户反馈行（离线评估视图；ADR-073 org 作用域；R2-SSV-26 global_admin 全局）。 */
  @Get('feedback/rows')
  feedbackRows(@Req() request?: { userContext?: OrgContext }): Promise<SchedulingFeedback[]> {
    const ctx = request?.userContext;
    return this.feedbackSvc.list(ctx?.primaryOrgId ?? null, {
      globalScope: Boolean(ctx?.isGlobalAdmin) && !ctx?.primaryOrgId,
    });
  }
}
