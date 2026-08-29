/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SchedulerService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
/**
 * SchedulerService Strangler Refactor（Task 2）：约束/策略候选应用写路径。
 *
 * 承载持久化人工约束的解除（deactivateConstraintV2）与候选策略版本注册
 * （registerPolicyVersion，inactive，绝不自动激活）。
 *
 * R2-SMI-010：两方法 actor 必传（fail-closed）——HTTP 外内部调用方漏传
 * actor 时不再静默降级为空 org 系统上下文（避免约束停用/策略注册落在
 * 无租户作用域，NEST-028/119 根因路径关闭）。
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type {
  SchedulingPolicyConfig,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';

function requireActor(actor: OrgContext | undefined, operation: string): OrgContext {
  if (!actor || !actor.primaryOrgId) {
    throw new UnauthorizedException(
      `scheduler.${operation} 缺少 actor 租户上下文（fail-closed）：内部调用必须显式传递系统/用户上下文`,
    );
  }
  return actor;
}

@Injectable()
export class SchedulerConstraintApplicationService {
  constructor(
    private readonly planService: PlanService,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /** P0-2：解除一条人工约束（软删除 + 审计）。 */
  async deactivateConstraintV2(
    constraintId: string,
    actor?: OrgContext,
    reason = '',
  ) {
    return this.planService.deactivateConstraint(
      constraintId,
      requireActor(actor, 'deactivateConstraintV2'),
      reason,
    );
  }

  /** 注册一个候选策略版本（inactive，绝不自动激活）。 */
  async registerPolicyVersion(
    config: SchedulingPolicyConfig,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyConfig> {
    const ctx = requireActor(actor, 'registerPolicyVersion');
    return this.policyService.registerCandidatePolicy(
      config,
      ctx.primaryOrgId,
      ctx.userId,
    );
  }
}
