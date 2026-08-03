import { Controller, Get, Post, Patch, Delete, Param, Query, Body, ParseIntPipe, BadRequestException, Req } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
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
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  async getOverview() {
    return this.dashboardService.getOverview();
  }

  @Get('environment/summary')
  async getEnvironmentSummary() {
    return this.dashboardService.getEnvironmentSummary();
  }

  @Get('devices')
  async getDevices(
    @Query('keyword') keyword?: string,
    @Query('online') online?: string,
    @Query('batteryMin') batteryMin?: string,
    @Query('batteryMax') batteryMax?: string,
    @Query('sourceType') sourceType?: string,
    @Query('model') model?: string,
    @Query('orderby') orderby?: string,
  ) {
    const query: DeviceSearchQuery = {};
    if (keyword) query.keyword = keyword;
    if (online !== undefined) query.online = online === 'true';
    if (batteryMin) query.batteryMin = parseInt(batteryMin);
    if (batteryMax) query.batteryMax = parseInt(batteryMax);
    if (sourceType) query.sourceType = sourceType;
    if (model) query.model = model;
    if (orderby) query.orderby = orderby;
    return this.dashboardService.getDevices(query);
  }

  @Get('devices/search')
  async searchDevices(
    @Query('keyword') keyword?: string,
    @Query('online') online?: string,
    @Query('batteryMin') batteryMin?: string,
    @Query('batteryMax') batteryMax?: string,
    @Query('sourceType') sourceType?: string,
    @Query('model') model?: string,
    @Query('firmwareVersion') firmwareVersion?: string,
    @Query('protocolVersion') protocolVersion?: string,
    @Query('faultCode') faultCode?: string,
    @Query('bindingStatus') bindingStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('orderby') orderby?: string,
  ) {
    const query: DeviceSearchQuery = {};
    if (keyword) query.keyword = keyword;
    if (online !== undefined) query.online = online === 'true';
    if (batteryMin) query.batteryMin = parseInt(batteryMin);
    if (batteryMax) query.batteryMax = parseInt(batteryMax);
    if (sourceType) query.sourceType = sourceType;
    if (model) query.model = model;
    if (firmwareVersion) query.firmwareVersion = firmwareVersion;
    if (protocolVersion) query.protocolVersion = protocolVersion;
    if (faultCode) query.faultCode = faultCode;
    if (bindingStatus === 'bound' || bindingStatus === 'unbound') query.bindingStatus = bindingStatus;
    if (page) query.page = parseInt(page);
    if (pageSize) query.pageSize = parseInt(pageSize);
    if (orderby) query.orderby = orderby;
    return this.dashboardService.searchDevices(query);
  }

  @Post('devices')
  async createDevice(@Body() body: CreateDeviceDto) {
    return this.dashboardService.createDevice(body);
  }

  @Patch('devices/:deviceId')
  async updateDevice(
    @Param('deviceId') deviceId: string,
    @Body() body: UpdateDeviceDto,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.dashboardService.updateDevice(deviceId, body, request.userContext);
  }

  @Get('devices/:deviceId/bindings')
  async getDeviceBindings(@Param('deviceId') deviceId: string) {
    return this.dashboardService.getDeviceBindings(deviceId);
  }

  @Post('devices/:deviceId/bindings')
  async bindDevice(@Param('deviceId') deviceId: string, @Body() body: BindDeviceRequest) {
    return this.dashboardService.bindDevice(deviceId, body);
  }

  @Delete('devices/:deviceId/bindings')
  async unbindDevice(@Param('deviceId') deviceId: string) {
    await this.dashboardService.unbindDevice(deviceId);
    return { success: true };
  }

  @Get('events')
  async getEvents(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const limitNum = limit ? parseInt(limit) : 50;
    return this.dashboardService.getEvents(limitNum, status);
  }

  @Get('events/stats')
  async getEventStats() {
    return this.dashboardService.getEventStats();
  }

  @Post('events/:eventId/handle')
  async handleEvent(
    @Param('eventId') eventId: string,
    @Body() body: { handlerAction?: string; handlerNote?: string; operator?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body.handlerAction || !body.handlerAction.trim()) {
      throw new BadRequestException('handlerAction is required');
    }
    return this.dashboardService.handleEvent(
      eventId,
      body.handlerAction,
      body.handlerNote,
      body.operator,
      request.userContext,
    );
  }

  @Get('telemetry/:deviceId')
  async getTelemetry(
    @Param('deviceId') deviceId: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit) : 50;
    return this.dashboardService.getTelemetry(deviceId, limitNum);
  }

  @Get('workers')
  async getWorkers() {
    return this.dashboardService.getWorkers();
  }
}
