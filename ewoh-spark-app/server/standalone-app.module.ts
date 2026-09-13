import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Module } from '@nestjs/common';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { createEwohValidationPipe } from './common/pipes/validation.pipe';
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
import { TelemetryModule } from './modules/telemetry/telemetry.module';
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
import { MasterDataModule } from './modules/master-data/master-data.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { ScaleModule } from './modules/scale/scale.module';
import { EventCatalogModule } from './modules/events/event-catalog.module';
import { PolicyModule } from './modules/policy/policy.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { OperationsModule } from './modules/operations/operations.module';
import { ParametersModule } from './modules/parameters/parameters.module';
import { AasModule } from './modules/aas/aas.module';
import { TracingModule } from './modules/tracing/tracing.module';
import { TracingInterceptor } from './modules/tracing/tracing.interceptor';
import { WorkOrchestrationModule } from './modules/work-orchestration/work-orchestration.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { QualityModule } from './modules/quality/quality.module';
import { WorkOrderModule } from './modules/workorder/workorder.module';
import { AgentModule } from './modules/agent/agent.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { InferenceModule } from './modules/inference/inference.module';
import { ReasoningModule } from './modules/reasoning/reasoning.module';
import { LearningModule } from './modules/learning/learning.module';
import { PerceptionModule } from './modules/perception/perception.module';
import { ReliabilityModule } from './modules/reliability/reliability.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { NotificationModule } from './modules/notification/notification.module';
import { ExoSessionModule } from './modules/exo/exo-session.module';
import { ShiftModule } from './modules/shift/shift.module';
import { DataQualityModule } from './modules/data-quality/data-quality.module';
import { RetrospectiveModule } from './modules/retrospective/retrospective.module';

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
    TelemetryModule,
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
    MasterDataModule,
    MaterialsModule,
    MobileModule,
    ScaleModule,
    EventCatalogModule,
    PolicyModule,
    OnboardingModule,
    WorkflowModule,
    OperationsModule,
    ParametersModule,
    AasModule,
    TracingModule,
    IdentityModule,
    MaintenanceModule,
    QualityModule,
    WorkOrderModule,
    AgentModule,
    KnowledgeModule,
    InferenceModule,
    ReasoningModule,
    LearningModule,
    PerceptionModule,
    ReliabilityModule,
    SimulationModule,
    NotificationModule,
    ExoSessionModule,
    ShiftModule,
    DataQualityModule,
    RetrospectiveModule,
    WorkOrchestrationModule,
    TimelineModule,
    ObservabilityModule,
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
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
  ],
})
export class StandaloneAppModule {}
