import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import type {
  ResourceAllocationRequest,
  TaskOrchestrationRequest,
  DispatchRequest,
  ExoFeedbackRequest,
  ApplyBrainSuggestionRequest,
} from '@shared/api.interface';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/gamification')
// 指挥地图面向指挥层开放：调度员/班组长/安全/管理员均可编排、下发、查看大脑建议、分配资源。
@Roles('dispatcher', 'workshop_lead', 'safety_admin', 'global_admin')
export class GamificationController {
  constructor(private readonly gamificationService: GamificationService) {}

  @Get('role')
  async getRole() {
    return this.gamificationService.getRole();
  }

  @Post('resources/allocate')
  async allocateResources(
    @Body() body: ResourceAllocationRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.gamificationService.allocateResources(body, request?.userContext);
  }

  @Post('tasks/orchestrate')
  async orchestrateTask(
    @Body() body: TaskOrchestrationRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.gamificationService.orchestrateTask(body, request?.userContext);
  }

  @Post('schedule/:planId/dispatch')
  async dispatchPlan(
    @Param('planId') planId: string,
    @Body() body: DispatchRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.gamificationService.dispatchPlan(planId, body, request?.userContext);
  }

  @Post('exo/:deviceId/feedback')
  async sendExoFeedback(@Param('deviceId') deviceId: string, @Body() body: ExoFeedbackRequest) {
    return this.gamificationService.sendExoFeedback(deviceId, body);
  }

  @Get('brain/suggestions')
  async getBrainSuggestions(@Req() request?: { userContext?: OrgContext }) {
    return this.gamificationService.getBrainSuggestions(request?.userContext);
  }

  @Post('brain/apply')
  async applyBrainSuggestion(
    @Body() body: ApplyBrainSuggestionRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.gamificationService.applyBrainSuggestion(body, request?.userContext);
  }
}
