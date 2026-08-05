import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { WorkbenchExportService } from './workbench-export.service';
import { WorkbenchViewService } from './workbench-view.service';
import { DangerousActionService } from './dangerous-action.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/operations')
@Roles('workshop_lead', 'dispatcher', 'device_ops', 'safety_admin', 'global_admin', 'worker')
export class OperationsController {
  constructor(
    private readonly operationsService: OperationsService,
    private readonly roleWorkbenchService: RoleWorkbenchService,
    private readonly workbenchExportService: WorkbenchExportService,
    private readonly workbenchViewService: WorkbenchViewService,
    private readonly dangerousActionService: DangerousActionService,
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

  // ===== 角色工作台：服务端分页/筛选/排序 + 异步大数导出 =====
  @Get('workbench/list')
  workbenchList(
    @Query('role') role: string,
    @Query('listKey') listKey: string,
    @Query() query: Record<string, unknown>,
    @Req() request: { userContext?: OrgContext },
    @Query('personId') personId?: string,
  ) {
    return this.roleWorkbenchService.getWorkbenchList(
      role,
      listKey,
      query,
      personId,
      request.userContext,
    );
  }

  @Post('workbench/export')
  createExport(
    @Body() body: { role: string; listKey: string; filter?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workbenchExportService.createExportTask(
      actorOf(request.userContext),
      body as never,
    );
  }

  @Get('workbench/export/:id')
  getExport(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workbenchExportService.getExportTask(
      id,
      actorOf(request.userContext),
    );
  }

  // ===== 角色工作台：保存视图服务端持久化 / 跨设备 / 共享 =====
  @Put('workbench/views/:key')
  saveView(
    @Param('key') key: string,
    @Body()
    body: {
      role: string;
      listKey: string;
      filter?: string;
      sortKey?: string;
      sortDir?: 'asc' | 'desc';
      limit?: number;
      shared?: boolean;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workbenchViewService.saveView(actorOf(request.userContext), {
      ...body,
      key,
    });
  }

  @Get('workbench/views')
  listViews(@Req() request: { userContext?: OrgContext }) {
    return this.workbenchViewService.listViews(actorOf(request.userContext));
  }

  @Delete('workbench/views/:key')
  deleteView(
    @Param('key') key: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workbenchViewService.deleteView(
      actorOf(request.userContext),
      key,
    );
  }

  // ===== 危险操作：影响预览 / 幂等确认 / 撤销补偿 =====
  @Post('dangerous/impact')
  dangerousImpact(@Body() body: Record<string, never>) {
    return this.dangerousActionService.preview(body as never);
  }

  @Post('dangerous/confirm')
  dangerousConfirm(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.dangerousActionService.confirm(
      actorOf(request.userContext),
      body as never,
    );
  }

  @Post('dangerous/:actionId/undo')
  dangerousUndo(
    @Param('actionId') actionId: string,
    @Body() body: { targetType: string; targetId: string; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.dangerousActionService.undo(
      actorOf(request.userContext),
      actionId,
      body.targetType,
      body.targetId,
      body.reason,
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

/** Normalises an optional OrgContext into the actor shape the RBAC helpers expect. */
function actorOf(context?: OrgContext): {
  userId: string;
  primaryOrgId: string;
  roles?: string[];
} {
  return {
    userId: context?.userId ?? 'anonymous',
    primaryOrgId: context?.primaryOrgId ?? 'org-unknown',
    roles: context?.roles ?? [],
  };
}
