import { Controller, Get, Post, Patch, Param, Query, Body, Req } from '@nestjs/common';
import { TaskService, CreateTaskDto } from './task.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * NEST-611（2026-08-17 审计整改）：补 @Roles（原先任何认证用户可创建/转移
 * 任务）。角色集与 route-role.policy FALLBACK 表一致。
 */
@Controller('api/tasks')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get()
  list(@Req() request: { userContext?: OrgContext }) {
    return this.taskService.listTasks(request.userContext);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: { userContext?: OrgContext }) {
    return this.taskService.getTask(id, request.userContext);
  }

  @Post()
  create(
    @Body() body: CreateTaskDto,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.taskService.createTask(body, request.userContext);
  }

  /**
   * 变更任务能力要求（设备/工位能力）——能力模型的唯一人工写入口。
   *
   * 语义：形状非法 400（不猜不截断）；未登记/当前无法匹配的能力名**允许**写入，
   * 但结果里带 warnings 显式提示（否则会得到"永远匹配不到资源"的任务而无从知晓）；
   * 变更留审计并触发重排（旧方案是按旧要求算出来的）。
   */
  @Patch(':id/requirements')
  updateRequirements(
    @Param('id') id: string,
    @Body()
    body: {
      requiredDeviceCapabilities?: string[];
      requiredStationCapabilities?: string[];
      /** NO-20a：放宽高风险能力时必须携带已获批的审批实例 id（否则 409）。 */
      approvalId?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.taskService.updateTaskRequirements(id, body, request.userContext);
  }

  @Post(':id/state')
  transition(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.taskService.transitionTaskState(
      id,
      action,
      request.userContext,
    );
  }
}
