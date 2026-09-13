import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { createEwohValidationPipe } from './common/pipes/validation.pipe';
import { ViewModule } from './modules/view/view.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SimulatorModule } from './modules/simulator/simulator.module';
import { SpatialModule } from './modules/spatial/spatial.module';
import { WorldModule } from './modules/world/world.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { RuleEngineModule } from './modules/rule-engine/rule-engine.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { SharedModule } from './modules/shared/shared.module';
import { OrgContextInterceptor } from './modules/shared/org-context.interceptor';
import { RolesGuard } from './modules/shared/roles.guard';
import { AccessTokenGuard } from './modules/shared/access-token.guard';
import { AuthModule } from './modules/auth/auth.module';
import { StandaloneDatabaseModule } from './database/standalone-database.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { ModelModule } from './modules/model/model.module';
import { SystemModule } from './modules/system/system.module';
import { TaskModule } from './modules/task/task.module';
import { AlertModule } from './modules/alert/alert.module';
import { ControlModule } from './modules/control/control.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { ResourceModule } from './modules/resource/resource.module';
import { AiModule } from './modules/ai/ai.module';
import { WorldCursorModule } from './modules/world-cursor/world-cursor.module';
import { AuditModule } from './modules/audit/audit.module';
import { OperationsModule } from './modules/operations/operations.module';
import { ParametersModule } from './modules/parameters/parameters.module';
import { AasModule } from './modules/aas/aas.module';
import { TracingModule } from './modules/tracing/tracing.module';
import { TracingInterceptor } from './modules/tracing/tracing.interceptor';
import { WorkOrchestrationModule } from './modules/work-orchestration/work-orchestration.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { NotificationModule } from './modules/notification/notification.module';
import { DeviceResponsibilityModule } from './modules/responsibility/device-responsibility.module';
import { ExoSessionModule } from './modules/exo/exo-session.module';
// NEST-507/515（2026-08-17，spec 已裁决：legacy 保留但补齐 guard/interceptor
// 至可用最小集）：legacy 入口补 RateLimitGuard 与 MetricsInterceptor。
import { RateLimitGuard } from './modules/shared/rate-limit.guard';
import { MetricsModule } from './modules/metrics/metrics.module';
import { MetricsInterceptor } from './modules/metrics/metrics.interceptor';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot(),
    // 租户 GUC 事务上下文；legacy 路径同样必须经过鉴权 + org 上下文
    StandaloneDatabaseModule,
    AuthModule,
    SharedModule,
    // ====== @route-section: business-modules START ======
    // Place all business modules here.Do NOT add fallback modules here.
    DashboardModule,
    SimulatorModule,
    SpatialModule,
    WorldModule,
    SchedulerModule,
    RuleEngineModule,
    IngestModule,
    GamificationModule,
    OrganizationModule,
    ModelModule,
    SystemModule,
    TaskModule,
    AlertModule,
    ControlModule,
    ApprovalModule,
    TelemetryModule,
    ResourceModule,
    AiModule,
    WorldCursorModule,
    AuditModule,
    OperationsModule,
    ParametersModule,
    AasModule,
    TracingModule,
    WorkOrchestrationModule,
    TimelineModule,
    ObservabilityModule,
    SimulationModule,
    NotificationModule,
    ExoSessionModule,
    // NO-49a：设备责任人（被多个提醒源消费：安灯开灯/升级、后续数据质量与维护提醒）。
    DeviceResponsibilityModule,
    // NEST-507/515：MetricsModule 提供 MetricsInterceptor 依赖（最小集补齐）。
    MetricsModule,
    // UX 埋点（J2 Gate G-1）：复用 ewoh_event 表，无新增表与迁移。
    TelemetryModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: createEwohValidationPipe(),
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: OrgContextInterceptor,
    },
    {
      provide: APP_GUARD,
      useExisting: AccessTokenGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // NEST-507/515：legacy 补齐限流与指标最小集（与 standalone 入口对齐；
    // 生产仍建议 EWOH_DEPLOY_TARGET=standalone，见 main.ts 警告）。
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
})
export class AppModule {}
