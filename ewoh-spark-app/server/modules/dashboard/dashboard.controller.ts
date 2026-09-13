import { Controller, Get, Post, Patch, Delete, Param, Query, Body, BadRequestException, Req } from '@nestjs/common';
import { WorkbenchNowService } from './workbench-now.service';
import {
  DashboardService,
  parseBatteryParam,
  parseLimitParam,
  parsePageParam,
} from './dashboard.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import type {
  DeviceSearchQuery,
  CreateDeviceDto,
  UpdateDeviceDto,
  BindDeviceRequest,
} from '@shared/api.interface';
import { Roles } from '../shared/roles.decorator';

@Controller('api/dashboard')
@Roles('global_admin', 'dispatcher', 'safety_admin', 'device_ops')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly workbenchNowService: WorkbenchNowService,
  ) {}

  @Get('overview')
  async getOverview(@Req() request?: { userContext?: OrgContext }) {
    return this.dashboardService.getOverview(request?.userContext);
  }

  /**
   * "现在需要我做什么"聚合（FR6 交互愿景）：班组长/调度员开机第一眼，
   * 把散落在异常/通知等域的"需要人处理"事实聚合为统一优先级列表。
   * 范围与裁决见 WorkbenchNowService 注释。
   */
  @Get('now')
  async getNow(@Req() request?: { userContext?: OrgContext }): Promise<{ items: unknown[]; generatedAt: string }> {
    return this.workbenchNowService.getNow(request?.userContext);
  }

  @Get('environment/summary')
  async getEnvironmentSummary(@Req() request?: { userContext?: OrgContext }) {
    return this.dashboardService.getEnvironmentSummary(request?.userContext);
  }

  @Get('devices')
  async getDevices(
    @Query('keyword') keyword?: string,
    @Query('online') online?: string,
    @Query('batteryMin') batteryMin?: string,
    @Query('batteryMax') batteryMax?: string,
    @Query('sourceType') sourceType?: string,
    @Query('category') category?: string,
    @Query('model') model?: string,
    @Query('orderby') orderby?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const query: DeviceSearchQuery = {};
    if (keyword) query.keyword = keyword;
    if (online !== undefined) query.online = online === 'true';
    // NEST-349：NaN 显式拒绝（不再把 NaN 传给 gte/lte）。
    const batteryMinNum = parseBatteryParam(batteryMin, 'batteryMin');
    const batteryMaxNum = parseBatteryParam(batteryMax, 'batteryMax');
    if (batteryMinNum !== undefined) query.batteryMin = batteryMinNum;
    if (batteryMaxNum !== undefined) query.batteryMax = batteryMaxNum;
    if (sourceType) query.sourceType = sourceType;
    if (category) query.category = category;
    if (model) query.model = model;
    if (orderby) query.orderby = orderby;
    return this.dashboardService.getDevices(query, request?.userContext);
  }

  @Get('devices/search')
  async searchDevices(
    @Query('keyword') keyword?: string,
    @Query('online') online?: string,
    @Query('batteryMin') batteryMin?: string,
    @Query('batteryMax') batteryMax?: string,
    @Query('sourceType') sourceType?: string,
    @Query('category') category?: string,
    @Query('model') model?: string,
    @Query('firmwareVersion') firmwareVersion?: string,
    @Query('protocolVersion') protocolVersion?: string,
    @Query('faultCode') faultCode?: string,
    @Query('bindingStatus') bindingStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('orderby') orderby?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const query: DeviceSearchQuery = {};
    if (keyword) query.keyword = keyword;
    if (online !== undefined) query.online = online === 'true';
    const batteryMinNum = parseBatteryParam(batteryMin, 'batteryMin');
    const batteryMaxNum = parseBatteryParam(batteryMax, 'batteryMax');
    if (batteryMinNum !== undefined) query.batteryMin = batteryMinNum;
    if (batteryMaxNum !== undefined) query.batteryMax = batteryMaxNum;
    if (sourceType) query.sourceType = sourceType;
    if (category) query.category = category;
    if (model) query.model = model;
    if (firmwareVersion) query.firmwareVersion = firmwareVersion;
    if (protocolVersion) query.protocolVersion = protocolVersion;
    if (faultCode) query.faultCode = faultCode;
    if (bindingStatus === 'bound' || bindingStatus === 'unbound') query.bindingStatus = bindingStatus;
    const pageNum = parsePageParam(page);
    if (page !== undefined && page !== '') query.page = pageNum;
    if (pageSize !== undefined && pageSize !== '') {
      const sizeNum = Number.parseInt(pageSize, 10);
      if (!Number.isFinite(sizeNum) || sizeNum < 1) {
        throw new BadRequestException(`invalid pageSize: ${pageSize}`);
      }
      query.pageSize = sizeNum;
    }
    if (orderby) query.orderby = orderby;
    return this.dashboardService.searchDevices(query, request?.userContext);
  }

  @Post('devices')
  async createDevice(
    @Body() body: CreateDeviceDto,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.createDevice(body, request?.userContext);
  }

  @Patch('devices/:deviceId')
  async updateDevice(
    @Param('deviceId') deviceId: string,
    @Body() body: UpdateDeviceDto,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.updateDevice(deviceId, body, request?.userContext);
  }

  @Get('devices/:deviceId/bindings')
  async getDeviceBindings(
    @Param('deviceId') deviceId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.getDeviceBindings(deviceId, request?.userContext);
  }

  @Post('devices/:deviceId/bindings')
  async bindDevice(
    @Param('deviceId') deviceId: string,
    @Body() body: BindDeviceRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.bindDevice(deviceId, body, request?.userContext);
  }

  @Delete('devices/:deviceId/bindings')
  async unbindDevice(
    @Param('deviceId') deviceId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    await this.dashboardService.unbindDevice(deviceId, request?.userContext);
    return { success: true };
  }

  @Get('events')
  async getEvents(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    /** 时间窗（小时）：默认 24，1~168；前端时间范围选择器（1h/6h/24h/7d）消费。 */
    @Query('hours') hours?: string,
    /** 分页偏移（配合 limit 翻页；默认 0）。 */
    @Query('offset') offset?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const limitNum = parseLimitParam(limit, 50);
    const hoursNum = hours != null && hours !== '' ? Number(hours) : undefined;
    const offsetNum = offset != null && offset !== '' ? Number(offset) : undefined;
    return this.dashboardService.getEvents(
      limitNum,
      status,
      request?.userContext,
      Number.isFinite(hoursNum) ? hoursNum : undefined,
      Number.isFinite(offsetNum) ? offsetNum : undefined,
    );
  }

  @Get('events/stats')
  async getEventStats(@Req() request?: { userContext?: OrgContext }) {
    return this.dashboardService.getEventStats(request?.userContext);
  }

  @Post('events/:eventId/handle')
  async handleEvent(
    @Param('eventId') eventId: string,
    @Body() body: { handlerAction?: string; handlerNote?: string; operator?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    if (!body.handlerAction || !body.handlerAction.trim()) {
      throw new BadRequestException('handlerAction is required');
    }
    return this.dashboardService.handleEvent(
      eventId,
      body.handlerAction,
      body.handlerNote,
      body.operator,
      request?.userContext,
    );
  }

  @Get('telemetry/:deviceId')
  async getTelemetry(
    @Param('deviceId') deviceId: string,
    @Query('limit') limit?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const limitNum = parseLimitParam(limit, 50);
    return this.dashboardService.getTelemetry(deviceId, limitNum, request?.userContext);
  }

  @Get('workers')
  async getWorkers(@Req() request?: { userContext?: OrgContext }) {
    return this.dashboardService.getWorkers(request?.userContext);
  }
}
