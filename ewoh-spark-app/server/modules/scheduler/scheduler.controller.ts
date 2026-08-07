import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import type {
  GeneratePlansRequest,
  ConfirmPlanRequest,
  ScheduleWeights,
  CreateRunRequest,
  ApprovePlanRequest,
  RejectPlanRequest,
  ReplanRequest,
  CalculateRouteRequest,
} from '@shared/api.interface';

@Controller('api/scheduler')
export class SchedulerController {
  constructor(private readonly schedulerService: SchedulerService) {}

  @Post('plans')
  async generatePlans(@Body() body?: GeneratePlansRequest) {
    return this.schedulerService.generatePlans(body);
  }

  @Post('plans/data-driven')
  async generateDataDrivenPlans(@Body() body?: GeneratePlansRequest) {
    return this.schedulerService.getDataDrivenPlans();
  }

  @Get('plans')
  async getPlans(@Query('status') status?: string) {
    return this.schedulerService.getPlans(status);
  }

  @Post('plans/:planId/confirm')
  async confirmPlan(
    @Param('planId') planId: string,
    @Body() body: ConfirmPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('reason is required');
    }
    return this.schedulerService.confirmPlan(
      planId,
      body.reason,
      body.operator,
      request.userContext,
    );
  }

  @Post('plans/:planId/reject')
  async rejectPlan(
    @Param('planId') planId: string,
    @Body() body: ConfirmPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('reason is required');
    }
    return this.schedulerService.rejectPlan(
      planId,
      body.reason,
      body.operator,
      request.userContext,
    );
  }

  @Get('audit')
  async getAudit(@Query('planId') planId?: string) {
    return this.schedulerService.getAudit(planId);
  }

  @Get('weights')
  async getWeights() {
    return this.schedulerService.getWeights();
  }

  @Put('weights')
  async updateWeights(
    @Body()
    body: {
      weights: ScheduleWeights;
      operator?: string;
      reason?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.updateWeights(
      body.weights,
      body.operator,
      body.reason,
      request.userContext,
    );
  }

  // ===== Scheduling V2 endpoints =====

  @Post('runs')
  async createRun(
    @Body() body: CreateRunRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.createRun(body, request.userContext);
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    return this.schedulerService.getRun(runId);
  }

  @Get('plans/:planId')
  async getPlan(@Param('planId') planId: string) {
    return this.schedulerService.getPlanDetail(planId);
  }

  @Post('plans/:planId/approve')
  async approvePlan(
    @Param('planId') planId: string,
    @Body() body: ApprovePlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.approvePlanV2(planId, body, request.userContext);
  }

  @Post('plans/:planId/reject')
  async rejectPlanV2(
    @Param('planId') planId: string,
    @Body() body: RejectPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.rejectPlanV2(planId, body, request.userContext);
  }

  @Post('plans/:planId/dispatch')
  async dispatchPlan(
    @Param('planId') planId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.dispatchPlanV2(planId, request.userContext);
  }

  @Post('plans/:planId/replan')
  async replan(
    @Param('planId') planId: string,
    @Body() body: ReplanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.replanV2(planId, body, request.userContext);
  }

  @Get('plans/:planId/compare/:otherPlanId')
  async comparePlans(
    @Param('planId') planId: string,
    @Param('otherPlanId') otherPlanId: string,
  ) {
    return this.schedulerService.comparePlansV2(planId, otherPlanId);
  }

  @Get('routes')
  async getRoutes() {
    return this.schedulerService.getRoutes();
  }

  @Post('routes/calculate')
  async calculateRoute(@Body() body: CalculateRouteRequest) {
    return this.schedulerService.calculateRouteV2(body);
  }
}
