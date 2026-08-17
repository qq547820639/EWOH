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
//   - NEST-119 修复（2026-08-17）：actor 缺失不再"安全"降级 system 匿名 ctx——
//     匿名 ctx（primaryOrgId=''）使 trigger 去重键退化为全租户共享 'ALL:...' 且
//     重排无 org 归属。桥接层显式拒绝无 actor 事件（TriggerService 在 HTTP
//     上下文同样 fail-closed，NEST-146）；后台系统触发需显式携带 org 上下文。

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { OrgContext } from '../shared/org-context.interceptor';
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
      // NEST-119：无 actor 的事件拒绝桥接（无法归属租户的重排是隔离缺口，
      // 不再静默以 system 匿名 ctx 触发跨租户重排）。
      if (!actor?.primaryOrgId) {
        this.logger.warn(
          `task event replan rejected (no org context) trigger=${trigger} task=${taskId}（NEST-119）`,
        );
        return;
      }
      // fire-and-forget：不阻塞任务写请求
      this.schedulerService
        .injectSchedulingEvent({ trigger, entityId: taskId }, actor as OrgContext)
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
