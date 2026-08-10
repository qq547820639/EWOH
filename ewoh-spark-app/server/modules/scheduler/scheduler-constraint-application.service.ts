/**
 * SchedulerService Strangler Refactor（Task 2）：约束/策略候选应用写路径。
 *
 * 承载持久化人工约束的解除（deactivateConstraintV2）与候选策略版本注册
 * （registerPolicyVersion，inactive，绝不自动激活）。
 */
import { Injectable } from '@nestjs/common';
import type {
  SchedulingPolicyConfig,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { toOrgContext } from './scheduler-run-context';

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
      toOrgContext(actor),
      reason,
    );
  }

  /** 注册一个候选策略版本（inactive，绝不自动激活）。 */
  async registerPolicyVersion(
    config: SchedulingPolicyConfig,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyConfig> {
    const ctx = toOrgContext(actor);
    return this.policyService.registerCandidatePolicy(
      config,
      ctx.primaryOrgId || null,
      ctx.userId,
    );
  }
}
