import { Controller, Get, Post, Param, Query, Body, Req } from '@nestjs/common';
import { TaskService, CreateTaskDto } from './task.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get()
  list() {
    return this.taskService.listTasks();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.taskService.getTask(id);
  }

  @Post()
  create(@Body() body: CreateTaskDto) {
    return this.taskService.createTask(body);
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
