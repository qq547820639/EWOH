import { Body, Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { DashboardService, parseBatteryParam } from './dashboard.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';
import type {
  DeviceSearchQuery,
  CreateDeviceDto,
  BindDeviceRequest,
} from '@shared/api.interface';

/**
 * NEST-350（2026-08-17 审计裁决，文档化）：本控制器是 /api/devices 契约面
 * （对外 openapi 路由），与 DashboardController 的 /api/dashboard/devices*
 * 共享同一 DashboardService —— org 谓词、校验与行为完全同源，无第二实现。
 * 两套路由并存是历史契约兼容（openapi/ewoh.yaml 已冻结 /api/devices 路径），
 * 收敛为单一路由属对外契约破坏，超出本整改边界；此处仅文档化职责边界。
 */
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
    /** BUG-006 修复：分页参数 */
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
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
    if (model) query.model = model;
    if (orderby) query.orderby = orderby;
    // BUG-006 修复：解析并应用 limit/offset 分页
    if (limit !== undefined && limit !== '') {
      const limitNum = Number.parseInt(limit, 10);
      if (Number.isFinite(limitNum) && limitNum > 0) query.limit = limitNum;
    }
    if (offset !== undefined && offset !== '') {
      const offsetNum = Number.parseInt(offset, 10);
      if (Number.isFinite(offsetNum) && offsetNum >= 0) query.offset = offsetNum;
    }
    return this.dashboardService.getDevices(query, request?.userContext);
  }

  @Get(':id')
  detail(@Param('id') id: string, @Req() request?: { userContext?: OrgContext }) {
    return this.dashboardService.getDeviceDetail(id, request?.userContext);
  }

  /** BUG-008 修复：为 /api/devices 添加 POST 创建端点（与 /api/dashboard/devices 共享同一 Service）。 */
  @Post()
  async create(
    @Body() body: CreateDeviceDto,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.createDevice(body, request?.userContext);
  }

  @Post(':id/bindings')
  bind(
    @Param('id') id: string,
    @Body() body: BindDeviceRequest,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.dashboardService.bindDevice(id, body, request?.userContext);
  }
}
