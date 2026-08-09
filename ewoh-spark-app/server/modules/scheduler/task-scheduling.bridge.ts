// task-scheduling.bridge.ts — A1：任务写路径 → 事件驱动重排桥接
//
// 背景（OPEN-DECISIONS 10.1）：TaskModule 是依赖叶子（SchedulerModule imports TaskModule），
// 若在 TaskService 直接注入 SchedulerService 会成环。解法：
//   TaskService 暴露 onTaskEvent 回调注册表（task 模块零依赖），
//   本桥（scheduler 模块，TaskModule 已在 imports）在启动时注册回调，
//   把任务写事件转发为 injectSchedulingEvent（TASK_CREATED / TASK_UPDATED）。
//
// 语义：
//   - fire-and-forget：任务写路径不等待重排结果，失败仅日志（任务主流程零影响）。
//   - 复用 injectSchedulingEvent 的冷却去抖 + 级联 + SAFETY 熔断（与 DEVICE_OFFLINE 同链路）。
//   - actor 缺失时 injectSchedulingEvent 走 toOrgContext(undefined) → system 匿名 ctx（安全）。

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TaskService } from '../task/task.service';
import { SchedulerService } from './scheduler.service';

@Injectable()
export class TaskSchedulingBridge implements OnModuleInit {
  private readonly logger = new Logger(TaskSchedulingBridge.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly schedulerService: SchedulerService,
  ) {}

  onModuleInit(): void {
    this.taskService.onTaskEvent((taskId, trigger, actor) => {
      // fire-and-forget：不阻塞任务写请求
      this.schedulerService
        .injectSchedulingEvent({ trigger, entityId: taskId }, actor)
        .catch((e: unknown) => {
          this.logger.warn(
            `task event replan failed trigger=${trigger} task=${taskId}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
    });
    this.logger.log('task write-path -> scheduler replan bridge registered');
  }
}
