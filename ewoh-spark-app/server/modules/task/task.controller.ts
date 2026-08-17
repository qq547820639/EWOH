import { Controller, Get, Post, Param, Query, Body, Req } from '@nestjs/common';
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
