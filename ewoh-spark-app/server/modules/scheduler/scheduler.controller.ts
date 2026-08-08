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
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import { SchedulerService } from './scheduler.service';
import { SchedulerStreamService } from './scheduler-stream.service';
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
  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly schedulerStreamService: SchedulerStreamService,
  ) {}

  /**
   * @deprecated 请改用 V2 接口 POST /api/scheduler/runs
   */
  @Post('plans')
  async generatePlans(@Body() body?: GeneratePlansRequest) {
    return this.legacyCompatibility(
      this.schedulerService.generatePlans(body),
      'POST /plans',
      'POST /api/scheduler/runs',
    );
  }

  @Post('plans/data-driven')
  async generateDataDrivenPlans(@Body() body?: GeneratePlansRequest) {
    return this.schedulerService.getDataDrivenPlans();
  }

  /**
   * @deprecated 请改用 V2 接口 GET /api/scheduler/runs/:runId 或 GET /api/scheduler/plans/:planId
   */
  @Get('plans')
  async getPlans(@Query('status') status?: string) {
    return this.legacyCompatibility(
      this.schedulerService.getPlans(status),
      'GET /plans',
      'GET /api/scheduler/plans/:planId',
    );
  }

  /**
   * @deprecated 请改用 V2 接口 POST /api/scheduler/plans/:planId/approve 或 /dispatch
   */
  @Post('plans/:planId/confirm')
  async confirmPlan(
    @Param('planId') planId: string,
    @Body() body: ConfirmPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('reason is required');
    }
    return this.legacyCompatibility(
      this.schedulerService.confirmPlan(
        planId,
        body.reason,
        body.operator,
        request.userContext,
      ),
      'POST /plans/:planId/confirm',
      'POST /api/scheduler/plans/:planId/approve',
    );
  }

  @Post('plans/:planId/reject')
  async rejectPlanV2(
    @Param('planId') planId: string,
    @Body() body: RejectPlanRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.rejectPlanV2(planId, body, request.userContext);
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

  @Get('tasks/:id/candidates')
  async getTaskCandidates(@Param('id') id: string) {
    return this.schedulerService.getTaskCandidates(id);
  }

  @Get('routes')
  async getRoutes() {
    return this.schedulerService.getRoutes();
  }

  @Post('routes/calculate')
  async calculateRoute(@Body() body: CalculateRouteRequest) {
    return this.schedulerService.calculateRouteV2(body);
  }

  // ===== Scheduling 实时事件流（SSE）=====

  /** SSE：订阅调度事件流，附带 15s 心跳防止连接超时。 */
  @Sse('v2/stream')
  stream(): Observable<MessageEvent> {
    this.schedulerStreamService.start().catch(() => undefined);
    return merge(
      this.schedulerStreamService.events().pipe(
        map(
          (event): MessageEvent => ({
            type: 'scheduling.event',
            id: event.eventId,
            data: JSON.stringify(event),
          }),
        ),
      ),
      interval(15_000).pipe(
        map(
          (): MessageEvent => ({
            type: 'heartbeat',
            data: JSON.stringify({ ts: new Date().toISOString() }),
          }),
        ),
      ),
    );
  }

  /**
   * 兼容适配器：legacy 模板风格接口仍委托到服务执行（保持向后可用），
   * 但响应携带废弃提示，引导调用方迁移到 V2 规范路径。新功能不得依赖 legacy 路径。
   */
  private async legacyCompatibility<T>(
    delegate: Promise<T>,
    legacyPath: string,
    v2Path: string,
  ): Promise<{ deprecated: true; notice: string; legacyPath: string; suggestedV2: string; data: T }> {
    const data = await delegate;
    return {
      deprecated: true,
      notice: `接口 ${legacyPath} 已废弃，请迁移到 V2 路径 ${v2Path}。`,
      legacyPath,
      suggestedV2: v2Path,
      data,
    };
  }
}