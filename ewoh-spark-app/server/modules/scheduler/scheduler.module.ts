import { Module } from '@nestjs/common';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';
import { WorldStateSnapshotService } from './world-state.service';
import { TriggerService } from './trigger.service';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TravelCostService } from './travel-cost.service';
import { DispatchCoordinatorService } from './dispatch-coordinator.service';
import { ResourceReservationService } from './resource-reservation.service';
import { OutboxService } from './outbox.service';
import { ResourceProjectionService } from './resource-projection.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SchedulerStreamService } from './scheduler-stream.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { SchedulerMetricsController } from './scheduler-metrics.controller';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { ConflictService } from './conflict.service';
import { PolicyReplayService } from './policy-replay.service';
import { ExecutionService } from './execution.service';
import { KpiService } from './kpi.service';
import { PlanCompareService } from './plan-compare.service';
import { ConflictPreviewService } from './conflict-preview.service';
import { ShadowPolicyService } from './shadow-policy.service';
import { PolicyActivationService } from './policy-activation.service';
import { TaskSchedulingBridge } from './task-scheduling.bridge';
import { ConstraintLoaderService } from './constraint-loader.service';
import { CandidateEngineService } from './candidate-engine.service';
import { OverridePreviewService } from './override-preview.service';
import { TaskModule } from '../task/task.module';

@Module({
  imports: [TaskModule],
  controllers: [SchedulerController, SchedulerMetricsController],
  providers: [
    SchedulerMetricsService,
    SchedulingFeedbackService,
    TaskSchedulingBridge,
    SchedulerService,
    WorldStateSnapshotService,
    TriggerService,
    EligibilityService,
    RoutingService,
    SchedulingPolicyService,
    TravelCostService,
    SolverService,
    PlanService,
    DispatchCoordinatorService,
    ResourceReservationService,
    OutboxService,
    ResourceProjectionService,
    ReplanCoordinatorService,
    SchedulerStreamService,
    ConflictService,
    PolicyReplayService,
    ExecutionService,
    KpiService,
    PlanCompareService,
    ConflictPreviewService,
    ShadowPolicyService,
    PolicyActivationService,
    ConstraintLoaderService,
    CandidateEngineService,
    OverridePreviewService,
  ],
  exports: [
    SchedulerService,
    SchedulerMetricsService,
    SchedulingFeedbackService,
    WorldStateSnapshotService,
    TriggerService,
    RoutingService,
    SchedulingPolicyService,
    TravelCostService,
    SolverService,
    PlanService,
    ReplanCoordinatorService,
    DispatchCoordinatorService,
    SchedulerStreamService,
    OutboxService,
    ResourceReservationService,
    ConflictService,
    PolicyReplayService,
    ExecutionService,
    KpiService,
    PlanCompareService,
    ConflictPreviewService,
    ShadowPolicyService,
    PolicyActivationService,
    ConstraintLoaderService,
    CandidateEngineService,
    OverridePreviewService,
  ],
})
export class SchedulerModule {}