import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { WorkbenchExportService } from './workbench-export.service';
import type { WorkbenchExportSpec } from './workbench-export.service';
import { WorkbenchViewService } from './workbench-view.service';
import {
  DangerousActionService,
  type DangerousConfirmInput,
} from './dangerous-action.service';
import type { DangerousActionSpec } from './dangerous-action';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * NEST-213：OrgContext 缺失时 401（绝不回退 anonymous/'org-unknown' 占位
 * 写入污染租户数据）。RBAC helper 需要的 actor 形状由此唯一入口派生。
 */
function actorOf(context?: OrgContext): {
  userId: string;
  primaryOrgId: string;
  roles?: string[];
} {
  const orgId = context?.primaryOrgId?.trim();
  if (!orgId || !context?.userId) {
    throw new UnauthorizedException(
      'org 上下文缺失：operations 写入/读取需要认证租户上下文',
    );
  }
  return {
    userId: context.userId,
    primaryOrgId: orgId,
    roles: context.roles ?? [],
  };
}

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
    @Body() body: WorkbenchExportSpec,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workbenchExportService.createExportTask(
      actorOf(request.userContext),
      body,
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
  // NEST-212：Record<string, never> + as never 绕过类型检查 → 显式 DTO 形状。
  @Post('dangerous/impact')
  dangerousImpact(@Body() body: DangerousActionSpec) {
    return this.dangerousActionService.preview(body);
  }

  @Post('dangerous/confirm')
  dangerousConfirm(
    @Body() body: DangerousConfirmInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.dangerousActionService.confirm(
      actorOf(request.userContext),
      body,
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
    @Body()
    body: {
      assetId?: string;
      name: string;
      category?: string;
      location?: string;
      strategy?: string;
      intervalDays?: number;
      nextDueAt?: string;
      description?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerAsset(
      body,
      request.userContext,
    );
  }

  @Get('assets')
  listAssets(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listAssets(request.userContext);
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
    @Body()
    body: {
      taskId?: string;
      assetId?: string;
      title: string;
      taskType?: string;
      priority?: string;
      assigneeId?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      description?: string;
      spareParts?: Array<{ name: string; quantity: number }>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerMaintenanceTask(
      body,
      request.userContext,
    );
  }

  @Get('tasks')
  listMaintenanceTasks(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listMaintenanceTasks(request.userContext);
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
    @Body()
    body: {
      toolId?: string;
      name: string;
      category?: string;
      lifespanLimit?: number;
      usageCount?: number;
      calibrationIntervalDays?: number;
      lastCalibratedAt?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerTool(
      body,
      request.userContext,
    );
  }

  @Get('tools')
  listTools(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listTools(request.userContext);
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
    @Body()
    body: {
      workCenterId?: string;
      name: string;
      location?: string;
      capabilities?: string[];
      flags?: Partial<Record<string, boolean>>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.upsertWorkCenter(
      body,
      request.userContext,
    );
  }

  @Get('work-centers')
  listWorkCenters(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listWorkCenters(request.userContext);
  }

  @Post('standard-hours')
  registerStandardHour(
    @Body()
    body: {
      standardHourId?: string;
      workCenterId: string;
      operationCode: string;
      operationName: string;
      standardMinutes: number;
      skillLevel?: string;
      effectiveFrom?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerStandardHour(
      body,
      request.userContext,
    );
  }

  @Get('standard-hours')
  listStandardHours(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listStandardHours(request.userContext);
  }

  @Post('efficiency')
  registerEfficiencyEntry(
    @Body()
    body: {
      entryId?: string;
      workerId: string;
      workCenterId: string;
      operationCode: string;
      actualMinutes: number;
      standardMinutes?: number;
      completedAt?: string;
      reason?: string;
      source?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.operationsService.registerEfficiencyEntry(
      body,
      request.userContext,
    );
  }

  @Get('efficiency')
  listEfficiencyEntries(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.listEfficiencyEntries(request.userContext);
  }

  @Get('efficiency/summary')
  efficiencySummary(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.efficiencySummary(request.userContext);
  }

  @Get('summary')
  summary(@Req() request: { userContext?: OrgContext }) {
    return this.operationsService.summary(request.userContext);
  }
}
