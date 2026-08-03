import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Roles } from '../shared/roles.decorator';
import type {
  DeviceSearchQuery,
  BindDeviceRequest,
} from '@shared/api.interface';

@Controller('api/devices')
@Roles('global_admin', 'dispatcher', 'device_ops')
export class DeviceContractController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  async list(
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

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.dashboardService.getDeviceDetail(id);
  }

  @Post(':id/bindings')
  bind(@Param('id') id: string, @Body() body: BindDeviceRequest) {
    return this.dashboardService.bindDevice(id, body);
  }
}
