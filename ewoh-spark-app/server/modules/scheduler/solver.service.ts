import { Injectable, Logger } from '@nestjs/common';
import type {
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';
import { RouteCostProvider } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { HeuristicSchedulingSolver } from './heuristic-scheduling-solver';
import type { SolveOptions } from './scheduling-solver.interface';

/** 求解器输入约束（来自重排/锁定）。 */
export interface SolverConstraint {
  taskId?: string;
  personId?: string;
  deviceId?: string;
  stationId?: string;
  zoneId?: string;
  type?: string;
  /** 时间窗/锁定时间（epoch ms），LOCKED_TIME 使用。 */
  startMs?: number;
  endMs?: number;
  /** MIN_BATTERY / MAX_WORKLOAD 等数值参数。 */
  value?: number;
}

export type { SolveOptions } from './scheduling-solver.interface';

/**
 * 求解器薄门面：保持既有公共 API（solve / solveVariants）不变，
 * 内部委托给确定性启发式求解器 HeuristicSchedulingSolver。
 */
@Injectable()
export class SolverService {
  private readonly logger = new Logger(SolverService.name);
  private readonly heuristicSolver: HeuristicSchedulingSolver;

  constructor(
    private readonly policyService: SchedulingPolicyService,
    routingService: RoutingService,
    routeCostProvider: RouteCostProvider,
    eligibilityService: EligibilityService,
  ) {
    this.heuristicSolver = new HeuristicSchedulingSolver(
      policyService,
      routingService,
      routeCostProvider,
      eligibilityService,
    );
  }

  /** 用三种策略权重生成方案 A/B/C。 */
  async solveVariants(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2[]> {
    const base = await this.policyService.getActivePolicy();
    const variants: Array<{ suffix: string; label: string; policy: SchedulingPolicy }> = [
      {
        suffix: 'A',
        label: '准时优先',
        policy: { ...base, latenessWeight: 3, changeCostWeight: 0.5 },
      },
      {
        suffix: 'B',
        label: '负荷均衡',
        policy: { ...base, workloadBalanceWeight: 3, walkingWeight: 1.5, latenessWeight: 0.5 },
      },
      {
        suffix: 'C',
        label: '均衡',
        policy: { ...base },
      },
    ];

    const plans: SchedulingPlanV2[] = [];
    for (const variant of variants) {
      const plan = await this.solve(snapshot, constraints, {
        ...opts,
        planId: `${opts.planId}${variant.suffix}`,
        planName: variant.label,
        policy: variant.policy,
      });
      plans.push(plan);
    }
    return plans;
  }

  /** 单次求解，返回一个完整方案。 */
  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    return this.heuristicSolver.solve(
      snapshot,
      this.toSchedulingConstraints(constraints),
      opts,
    );
  }

  /** 将遗留的开放字符串约束转换为统一 SchedulingConstraint。 */
  private toSchedulingConstraints(
    constraints: SolverConstraint[],
  ): SchedulingConstraint[] {
    return constraints
      .filter((c): c is SolverConstraint & { type: string } => Boolean(c.type))
      .map((c) => c as unknown as SchedulingConstraint);
  }
}