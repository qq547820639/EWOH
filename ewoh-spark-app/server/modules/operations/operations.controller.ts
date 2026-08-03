import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/operations')
@Roles('workshop_lead', 'dispatcher', 'device_ops', 'safety_admin', 'global_admin', 'worker')
export class OperationsController {
  constructor(
    private readonly operationsService: OperationsService,
    private readonly roleWorkbenchService: RoleWorkbenchService,
  ) {}

  @Get('role-workbench')
  roleWorkbench(
    @Query('role') role: string,
    @Req() request: { userContext?: OrgContext },
    @Query('personId') personId?: string,
  ) {
    return this.roleWorkbenchService.getWorkbench(
      role,
      personId,
      request.userContext,
    );
  }

  @Post('assets')
  registerAsset(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerAsset(
      body as never,
      request.userContext,
    );
  }

  @Get('assets')
  listAssets() {
    return this.operationsService.listAssets();
  }

  @Post('assets/:id/state')
  transitionAsset(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.transitionAsset(
      id,
      action,
      request.userContext,
    );
  }

  @Post('tasks')
  registerMaintenanceTask(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerMaintenanceTask(
      body as never,
      request.userContext,
    );
  }

  @Get('tasks')
  listMaintenanceTasks() {
    return this.operationsService.listMaintenanceTasks();
  }

  @Post('tasks/:id/state')
  transitionMaintenanceTask(
    @Param('id') id: string,
    @Query('action') action: string,
    @Body() body: { result?: string; note?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.transitionMaintenanceTask(
      id,
      action,
      body,
      request.userContext,
    );
  }

  @Post('tools')
  registerTool(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerTool(
      body as never,
      request.userContext,
    );
  }

  @Get('tools')
  listTools() {
    return this.operationsService.listTools();
  }

  @Post('tools/:id/state')
  transitionTool(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.transitionTool(
      id,
      action,
      request.userContext,
    );
  }

  @Post('work-centers')
  upsertWorkCenter(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.upsertWorkCenter(
      body as never,
      request.userContext,
    );
  }

  @Get('work-centers')
  listWorkCenters() {
    return this.operationsService.listWorkCenters();
  }

  @Post('standard-hours')
  registerStandardHour(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerStandardHour(
      body as never,
      request.userContext,
    );
  }

  @Get('standard-hours')
  listStandardHours() {
    return this.operationsService.listStandardHours();
  }

  @Post('efficiency')
  registerEfficiencyEntry(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerEfficiencyEntry(
      body as never,
      request.userContext,
    );
  }

  @Get('efficiency')
  listEfficiencyEntries() {
    return this.operationsService.listEfficiencyEntries();
  }

  @Get('efficiency/summary')
  efficiencySummary() {
    return this.operationsService.efficiencySummary();
  }

  @Get('summary')
  summary() {
    return this.operationsService.summary();
  }
}
