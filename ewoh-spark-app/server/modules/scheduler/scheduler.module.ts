import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';
import { SchedulingNarratorService } from './narration/scheduling-narrator.service';
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
import { SchedulerStreamService, SCHEDULER_STREAM_NOTIFY_LISTENER } from './scheduler-stream.service';
import { PgNotifyListener } from './pg-notify.listener';
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
import { SchedulingContextService } from './scheduling-context.service';
import { CandidateEngineService } from './candidate-engine.service';
import { OverridePreviewService } from './override-preview.service';
import { ReplanPreviewService } from './replan-preview.service';
import { EmpiricalDurationPredictionProvider, PREDICTION_PROVIDER } from './prediction/empirical-duration-prediction-provider';
import { DurationModelTrainingService } from './prediction/duration-model-training.service';
import { DecisionHistoryService } from './decision-history.service';
import { ShadowEvaluatorService } from './prediction/shadow-evaluator.service';
import { TaskModule } from '../task/task.module';
// P1-6：跨实例 replan 守卫降级状态持有（readiness 上报 ReplanGuardStatusService）。
import { HealthModule } from '../health/health.module';
// NO-12s / ADR-042：审批前自动布局仿真预验证（SimulationService 注入 PlanService）。
import { SimulationModule } from '../simulation/simulation.module';

/**
 * Task 6：Outbox → LISTEN/NOTIFY 低延迟 wake-up。
 * 仅当 SCHEDULER_STREAM_NOTIFY=1 且存在 DATABASE_URL/SUDA_DATABASE_URL 时提供 notifyListener，
 * 否则不注册 token（SchedulerStreamService 经 @Optional 注入 undefined → 纯轮询，现状行为不变）。
 * 注意：module 定义时读取 env，与仓库内其它 import-time env 读取（如 ai.controller）一致。
 */
const SCHEDULER_NOTIFY_URL =
  process.env.SCHEDULER_STREAM_NOTIFY === '1'
    ? process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL || ''
    : '';
const SCHEDULER_NOTIFY_PROVIDERS = SCHEDULER_NOTIFY_URL
  ? [
      {
        provide: SCHEDULER_STREAM_NOTIFY_LISTENER,
        // Task 3 埋点：LISTEN 断线重连时经 metricsService 计数
        // （PgNotifyListener 由 useFactory 手工构造，避免构造注入，改以回调解耦）。
        useFactory: (metricsService: SchedulerMetricsService) =>
          new PgNotifyListener(SCHEDULER_NOTIFY_URL, undefined, () =>
            metricsService.recordListenerReconnect(),
          ),
      },
    ]
  : [];

@Module({
  imports: [TaskModule, HealthModule, SimulationModule, AiModule],
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
    // P0-2：统一调度上下文（GET /api/scheduler/context）。
    SchedulingContextService,
    CandidateEngineService,
    OverridePreviewService,
    ReplanPreviewService,
    ShadowEvaluatorService,
    // AI 调度说明层（2026-08-21）：方案落库后异步生成自然语言说明。
    SchedulingNarratorService,
    // Task 5 / PredictionProvider（shadow only）：预测只是优化器输入，
    // 绝不写生产调度、绝不替代 hard constraints。消费者应将其视为可选。
    // NO-13g / ADR-056：经验时长模型优先（真实统计，训练自执行反馈；
    // 未训练/OOD 显式回退确定性基线）。
    { provide: PREDICTION_PROVIDER, useClass: EmpiricalDurationPredictionProvider },
    // NO-13g / ADR-056：模型重训/激活闭环（唯一权威写路径）。
    DurationModelTrainingService,
    // NO-13p / ADR-065：Decision History 跨 kind 检索（只读聚合读面）。
    DecisionHistoryService,
    // Task 6：NOTIFY wake-up 监听器（条件装配，默认不提供）。
    ...SCHEDULER_NOTIFY_PROVIDERS,
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
    SchedulingContextService,
    CandidateEngineService,
    OverridePreviewService,
    ReplanPreviewService,
    ShadowEvaluatorService,
    // Task 5：暴露预测提供者 token，消费方可按需注入（shadow only）。
    PREDICTION_PROVIDER,
  ],
})
export class SchedulerModule {}