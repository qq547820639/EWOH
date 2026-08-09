import { Injectable, Logger, Optional } from '@nestjs/common';
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
import type { SchedulerMetricsService } from './scheduler-metrics.service';
import { HeuristicSchedulingSolver } from './heuristic-scheduling-solver';
import type { CandidateEngineService } from './candidate-engine.service';
import {
  CpSatSchedulingSolver,
  type CpSatSolverConfig,
} from './cp-sat-scheduling-solver';
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
 * 内部优先委托给 CP-SAT Worker（不可用时回退到确定性启发式 HeuristicSchedulingSolver）。
 */
@Injectable()
export class SolverService {
  private readonly logger = new Logger(SolverService.name);
  private readonly heuristicSolver: HeuristicSchedulingSolver;
  private readonly cpSatSolver: CpSatSchedulingSolver;

  constructor(
    private readonly policyService: SchedulingPolicyService,
    routingService: RoutingService,
    routeCostProvider: RouteCostProvider,
    eligibilityService: EligibilityService,
    @Optional() cpSatConfig?: CpSatSolverConfig,
    @Optional() private readonly metricsService?: SchedulerMetricsService,
    // T03 / P1-2（G7）：候选引擎（可选注入；注入后 heuristic 候选生成与端点共享语义）。
    @Optional() private readonly candidateEngine?: CandidateEngineService,
  ) {
    this.heuristicSolver = new HeuristicSchedulingSolver(
      policyService,
      routingService,
      routeCostProvider,
      eligibilityService,
      undefined,
      metricsService,
      undefined,
      candidateEngine,
    );
    this.cpSatSolver = new CpSatSchedulingSolver(
      this.heuristicSolver,
      cpSatConfig,
      // P2-T1：routeCostProvider 即 TravelCostService（兼容别名），供矩阵可行性过滤。
      routeCostProvider,
      metricsService,
    );
  }

  /** 用三种策略权重预设生成方案 A/B/C（权重来自版本化 SchedulingPolicy，乘预设缩放系数）。 */
  async solveVariants(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2[]> {
    const base = await this.policyService.getActivePolicy();
    // 预设权重画像：仅作用于版本化策略已有的权重域（不新增第 4 个领域），
    // 实际投放目标权重 = 基策略对应字段 × 预设缩放系数，保证三变体真正不同且可解释。
    const profiles: Array<{
      suffix: string;
      label: string;
      reason: string;
      scale: Partial<
        Pick<
          SchedulingPolicy,
          | 'latenessWeight'
          | 'walkingWeight'
          | 'workloadBalanceWeight'
          | 'stationWaitWeight'
          | 'changeCostWeight'
          | 'riskWeight'
          | 'energyWeight'
        >
      >;
    }> = [
      {
        suffix: 'A',
        label: '准时优先',
        reason: '准时优先：latenessWeight×3、changeCostWeight×0.5',
        scale: { latenessWeight: 3, changeCostWeight: 0.5 },
      },
      {
        suffix: 'B',
        label: '负荷均衡',
        reason: '负荷均衡：workloadBalanceWeight×3、walkingWeight×1.5、latenessWeight×0.5',
        scale: {
          workloadBalanceWeight: 3,
          walkingWeight: 1.5,
          latenessWeight: 0.5,
        },
      },
      {
        suffix: 'C',
        label: '综合平衡',
        reason: '综合平衡：沿用版本化策略全部权重（不缩放）',
        scale: {},
      },
    ];

    const plans: SchedulingPlanV2[] = [];
    for (const profile of profiles) {
      const variantPolicy: SchedulingPolicy = {
        ...base,
        // Phase 2 / P2-T2：8 权重权威缩放（weights 与兼容旧字段同步缩放）。
        weights: {
          lateness: base.weights.lateness * (profile.scale.latenessWeight ?? 1),
          travel: base.weights.travel * (profile.scale.walkingWeight ?? 1),
          wait: base.weights.wait,
          workload:
            base.weights.workload * (profile.scale.workloadBalanceWeight ?? 1),
          station: base.weights.station,
          change: base.weights.change * (profile.scale.changeCostWeight ?? 1),
          risk: base.weights.risk,
          energy: base.weights.energy,
        },
        latenessWeight: base.latenessWeight * (profile.scale.latenessWeight ?? 1),
        walkingWeight: base.walkingWeight * (profile.scale.walkingWeight ?? 1),
        workloadBalanceWeight:
          base.workloadBalanceWeight * (profile.scale.workloadBalanceWeight ?? 1),
        stationWaitWeight:
          base.stationWaitWeight * (profile.scale.stationWaitWeight ?? 1),
        changeCostWeight:
          base.changeCostWeight * (profile.scale.changeCostWeight ?? 1),
        riskWeight: base.riskWeight * (profile.scale.riskWeight ?? 1),
        energyWeight: base.energyWeight * (profile.scale.energyWeight ?? 1),
      };
      const plan = await this.solve(snapshot, constraints, {
        ...opts,
        planId: `${opts.planId}${profile.suffix}`,
        planName: profile.label,
        policy: variantPolicy,
      });
      // 记录变体标签/原因与投放权重，保证差异可解释且随方案持久化。
      plan.baselineDelta = {
        ...plan.baselineDelta,
        variant: {
          label: profile.label,
          reason: profile.reason,
          weights: {
            latenessWeight: variantPolicy.latenessWeight,
            workloadBalanceWeight: variantPolicy.workloadBalanceWeight,
            walkingWeight: variantPolicy.walkingWeight,
            changeCostWeight: variantPolicy.changeCostWeight,
          },
        },
      };
      plans.push(plan);
    }
    return plans;
  }

  /** 单次求解，返回一个完整方案（优先 CP-SAT，失败回退启发式）。 */
  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const started = Date.now();
    const plan = await this.cpSatSolver.solve(
      snapshot,
      this.toSchedulingConstraints(constraints),
      opts,
    );
    // Phase 2 / P2-T3：Solver 可观测埋点（churn / 局部重排影响数；失败仅记日志）。
    if (this.metricsService) {
      try {
        const churn = this.computeChurn(plan, opts);
        if (churn > 0) this.metricsService.recordPlanChurn(churn);
        if (opts.triggerType && opts.triggerType !== 'MANUAL') {
          const affected = this.affectedTaskCount(snapshot, opts);
          this.metricsService.recordPartialReplanAffected(affected);
        }
        this.metricsService.recordRun({
          durationMs: Math.max(Date.now() - started, 0),
          feasible:
            plan.assignments.length >=
            snapshot.tasks.filter(
              (t) => !['completed', 'cancelled'].includes(t.status),
            ).length,
          solverVersion: plan.solverVersion,
          solverStatus: plan.solverStatus,
        });
      } catch (err) {
        this.logger.warn(
          `solver metrics recording failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return plan;
  }

  /** 计算方案相对基线的 churn（改派/新增/移除的任务数）。 */
  private computeChurn(
    plan: SchedulingPlanV2,
    opts: SolveOptions,
  ): number {
    const baseline = opts.baselineAssignee ?? new Map<string, string | null>();
    const assignedByTask = new Map(plan.assignments.map((a) => [a.taskId, a]));
    let churn = 0;
    for (const taskId of new Set([...baseline.keys(), ...assignedByTask.keys()])) {
      const prev = baseline.get(taskId);
      const cur = assignedByTask.get(taskId)?.personId ?? null;
      if (prev !== cur) churn += 1;
    }
    return churn;
  }

  /** 局部重排影响任务数（来自影响分析的 affected 语义，无则按快照任务数近似）。 */
  private affectedTaskCount(
    snapshot: WorldStateSnapshot,
    opts: SolveOptions,
  ): number {
    void opts;
    return snapshot.tasks.length;
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