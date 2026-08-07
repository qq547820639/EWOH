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
import { RouteCostProvider } from './route-cost.provider';
import { DispatchCoordinatorService } from './dispatch-coordinator.service';
import { ResourceReservationService } from './resource-reservation.service';
import { OutboxService } from './outbox.service';
import { ResourceProjectionService } from './resource-projection.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SchedulerStreamService } from './scheduler-stream.service';
import { TaskModule } from '../task/task.module';

@Module({
  imports: [TaskModule],
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    WorldStateSnapshotService,
    TriggerService,
    EligibilityService,
    RoutingService,
    SchedulingPolicyService,
    RouteCostProvider,
    SolverService,
    PlanService,
    DispatchCoordinatorService,
    ResourceReservationService,
    OutboxService,
    ResourceProjectionService,
    ReplanCoordinatorService,
    SchedulerStreamService,
  ],
  exports: [
    WorldStateSnapshotService,
    TriggerService,
    RoutingService,
    SchedulingPolicyService,
    RouteCostProvider,
    SolverService,
    PlanService,
    ReplanCoordinatorService,
    DispatchCoordinatorService,
    SchedulerStreamService,
    OutboxService,
    ResourceReservationService,
  ],
})
export class SchedulerModule {}