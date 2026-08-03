import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Module } from '@nestjs/common';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { SharedModule } from './modules/shared/shared.module';
import { OrgContextInterceptor } from './modules/shared/org-context.interceptor';
import { RolesGuard } from './modules/shared/roles.guard';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SimulatorModule } from './modules/simulator/simulator.module';
import { SpatialModule } from './modules/spatial/spatial.module';
import { WorldModule } from './modules/world/world.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { RuleEngineModule } from './modules/rule-engine/rule-engine.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { ModelModule } from './modules/model/model.module';
import { SystemModule } from './modules/system/system.module';
import { TaskModule } from './modules/task/task.module';
import { AlertModule } from './modules/alert/alert.module';
import { ControlModule } from './modules/control/control.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { ResourceModule } from './modules/resource/resource.module';
import { AiModule } from './modules/ai/ai.module';
import { WorldCursorModule } from './modules/world-cursor/world-cursor.module';
import { StandaloneDatabaseModule } from './database/standalone-database.module';
import { AuthModule } from './modules/auth/auth.module';
import { RateLimitGuard } from './modules/shared/rate-limit.guard';
import { FilesModule } from './modules/files/file.module';
import { AccessTokenGuard } from './modules/shared/access-token.guard';
import { HealthModule } from './modules/health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { MetricsInterceptor } from './modules/metrics/metrics.interceptor';
import { MesModule } from './modules/mes/mes.module';
import { OeeModule } from './modules/oee/oee.module';
import { ErpModule } from './modules/erp/erp.module';

@Module({
  imports: [
    StandaloneDatabaseModule,
    AuthModule,
    SharedModule,
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
    ResourceModule,
    AiModule,
    WorldCursorModule,
    FilesModule,
    HealthModule,
    AuditModule,
    MetricsModule,
    MesModule,
    OeeModule,
    ErpModule,
  ],
  providers: [
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
export class StandaloneAppModule {}
