import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { OeeService } from './oee.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/oee')
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin')
export class OeeController {
  constructor(private readonly oeeService: OeeService) {}

  @Post('device-status')
  recordDeviceStatus(
    @Body() body: {
      deviceId: string;
      status: 'running' | 'idle' | 'fault' | 'changeover' | 'material_missing' | 'unmanned';
      reason?: string;
      startedAt?: string;
      endedAt?: string;
      sourceType?: string;
      outputQty?: number;
      idealRatePerSec?: number;
    },
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.recordDeviceStatus(body, request?.userContext);
  }

  @Get('device-status')
  listDeviceStatus(
    @Query('deviceId') deviceId?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.listDeviceStatus(deviceId, start, end, request?.userContext);
  }

  @Post('calculate')
  calculate(
    @Query('deviceId') deviceId: string,
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('plannedTimeSec') plannedTimeSec = '0',
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.calculateOee(
      deviceId,
      start,
      end,
      Number(plannedTimeSec),
      request?.userContext,
    );
  }

  @Post('andons')
  openAndon(
    @Body() body: {
      deviceId: string;
      title: string;
      reason?: string;
      severity?: string;
      slaSeconds?: number;
      assignee?: string;
    },
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.openAndon(body, request?.userContext);
  }

  @Get('andons')
  listAndons(@Req() request?: { userContext?: OrgContext }) {
    return this.oeeService.listAndons(request?.userContext);
  }

  @Post('andons/:id/state')
  transitionAndon(
    @Param('id') id: string,
    @Query('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.transitionAndon(id, action, body, request?.userContext);
  }

  @Get('summary')
  summary(
    @Query('deviceId') deviceId: string,
    @Query('start') start: string,
    @Query('end') end: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.oeeService.getSummary(deviceId, start, end, request?.userContext);
  }
}
