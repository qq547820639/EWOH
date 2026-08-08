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
import { ResourceProjectionService } from './resource-projection.service';
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
  PlanOverrideRequest,
  SchedulingPolicyConfig,
} from '@shared/api.interface';

@Controller('api/scheduler')
export class SchedulerController {
  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly schedulerStreamService: SchedulerStreamService,
    private readonly resourceProjectionService: ResourceProjectionService,
  ) {}

  /**
   * P1-CMAP-002：统一资源状态权威投影（ResourceProjection SSOT）。
   * map / ResourcePool / Scheduler / Dispatch 应统一从此消费；
   * 前端 ResourcePool 不得自行拼装 SpatialEntity/DeviceInfo 作为正式资源状态。
   */
  @Get('resources/state')
  async getUnifiedResourceState() {
    return this.resourceProjectionService.getUnifiedResourceState();
  }

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

  @Get('runs')
  async listRuns(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.schedulerService.listRuns({
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      from,
      to,
    });
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    return this.schedulerService.getRun(runId);
  }

  @Get('snapshot')
  async getSnapshot() {
    return this.schedulerService.getSnapshot();
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

  /** 应用人工覆盖（锁定/排除/偏好/加急/调时）并触发 V2 重排，返回 before/after 差异。 */
  @Post('plans/:planId/overrides')
  async applyOverrides(
    @Param('planId') planId: string,
    @Body() body: PlanOverrideRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.applyOverrides(planId, body, request.userContext);
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

  @Get('conflicts')
  async listConflicts(
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('scope') scope?: string,
    @Query('resourceId') resourceId?: string,
  ) {
    return this.schedulerService.listConflicts({
      type,
      severity,
      scope,
      resourceId,
    } as never);
  }

  @Get('conflicts/:id')
  async getConflict(@Param('id') id: string) {
    return this.schedulerService.getConflictDetail(id);
  }

  // ===== SchedulingPolicy versioning (Task 6: 命令图调度闭环) =====

  /** 返回当前生效策略 + 配置（只读）。 */
  @Get('policy')
  async getPolicy() {
    return this.schedulerService.getPolicy();
  }

  /** 列出全部策略版本（含 active 标志、操作人、创建时间）。 */
  @Get('policy/versions')
  async listPolicyVersions() {
    return this.schedulerService.listPolicyVersions();
  }

  /** 注册候选策略版本（inactive，绝不自动激活）。 */
  @Post('policy/versions')
  async registerPolicyVersion(
    @Body() body: { config: SchedulingPolicyConfig; operator?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.config) {
      throw new BadRequestException('config is required');
    }
    return this.schedulerService.registerPolicyVersion(
      body.config,
      request.userContext,
    );
  }

  /** shadow/只读对比：候选版本 vs 当前生效版本（反馈 KPI + 目标权重）。 */
  @Get('policy/versions/:version/compare')
  async comparePolicyVersion(
    @Param('version') version: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.comparePolicyVersion(
      this.parsePolicyVersion(version),
      request.userContext,
    );
  }

  /** 显式激活指定版本（唯一生产策略翻转路径，需人工审批 + 审计）。 */
  @Post('policy/versions/:version/activate')
  async activatePolicyVersion(
    @Param('version') version: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.schedulerService.activatePolicyVersion(
      this.parsePolicyVersion(version),
      request.userContext,
    );
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

  /** 解析并校验策略版本号（正整数）。 */
  private parsePolicyVersion(version: string): number {
    const v = Number(version);
    if (!Number.isInteger(v) || v <= 0) {
      throw new BadRequestException('invalid policy version');
    }
    return v;
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