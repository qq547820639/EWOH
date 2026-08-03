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
    ResourceModule,
    AiModule,
    WorldCursorModule,
    AuditModule,
    OperationsModule,
    ParametersModule,
    AasModule,
    TracingModule,
    WorkOrchestrationModule,
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
  ],
})
export class AppModule {}
