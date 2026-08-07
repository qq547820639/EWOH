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
}
