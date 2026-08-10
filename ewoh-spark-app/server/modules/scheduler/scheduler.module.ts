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
import { DeterministicPredictionProvider } from './prediction/prediction-provider';
import { TaskModule } from '../task/task.module';

/** 预测提供者注入 token（shadow only）：消费者应将其视为可选。 */
export const PREDICTION_PROVIDER = 'PREDICTION_PROVIDER';

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
    // Task 5 / PredictionProvider（shadow only）：确定性基线。预测只是优化器输入，
    // 绝不写生产调度、绝不替代 hard constraints。消费者应将其视为可选。
    { provide: PREDICTION_PROVIDER, useClass: DeterministicPredictionProvider },
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
    // Task 5：暴露预测提供者 token，消费方可按需注入（shadow only）。
    PREDICTION_PROVIDER,
  ],
})
export class SchedulerModule {}