import { Module } from '@nestjs/common';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';
import { WorldStateSnapshotService } from './world-state.service';
import { TriggerService } from './trigger.service';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';

@Module({
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    WorldStateSnapshotService,
    TriggerService,
    EligibilityService,
    RoutingService,
    SolverService,
    PlanService,
  ],
  exports: [
    WorldStateSnapshotService,
    TriggerService,
    RoutingService,
    SolverService,
    PlanService,
  ],
})
export class SchedulerModule {}