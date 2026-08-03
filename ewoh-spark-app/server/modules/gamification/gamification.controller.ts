import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import type {
  ResourceAllocationRequest,
  TaskOrchestrationRequest,
  DispatchRequest,
  ExoFeedbackRequest,
} from '@shared/api.interface';
import { Roles } from '../shared/roles.decorator';

@Controller('api/gamification')
// access-matrix.yaml has no gamification center; conservative admin-only default.
@Roles('global_admin', 'safety_admin')
export class GamificationController {
  constructor(private readonly gamificationService: GamificationService) {}

  @Get('role')
  async getRole() {
    return this.gamificationService.getRole();
  }

  @Post('resources/allocate')
  async allocateResources(@Body() body: ResourceAllocationRequest) {
    return this.gamificationService.allocateResources(body);
  }

  @Post('tasks/orchestrate')
  async orchestrateTask(@Body() body: TaskOrchestrationRequest) {
    return this.gamificationService.orchestrateTask(body);
  }

  @Post('schedule/:planId/dispatch')
  async dispatchPlan(@Param('planId') planId: string, @Body() body: DispatchRequest) {
    return this.gamificationService.dispatchPlan(planId, body);
  }

  @Post('exo/:deviceId/feedback')
  async sendExoFeedback(@Param('deviceId') deviceId: string, @Body() body: ExoFeedbackRequest) {
    return this.gamificationService.sendExoFeedback(deviceId, body);
  }

  @Get('brain/suggestions')
  async getBrainSuggestions() {
    return this.gamificationService.getBrainSuggestions();
  }
}
