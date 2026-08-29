/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SchedulerService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
/**
 * SchedulerService Strangler Refactor（Task 2）：V2 重排应用（replanV2）。
 *
 * 薄委托：replanV2 仅做 org 上下文归一化后转发 planService.replan
 * （重排求解/约束继承/状态机均在 PlanService 内）。
 */
import { Injectable } from '@nestjs/common';
import type {
  SchedulingPlanV2,
  ReplanRequest,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { PlanService } from './plan.service';
import { toOrgContext } from './scheduler-run-context';

@Injectable()
export class SchedulerReplanApplicationService {
  constructor(private readonly planService: PlanService) {}

  async replanV2(
    planId: string,
    body: ReplanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.replan(planId, body, toOrgContext(actor));
  }
}
