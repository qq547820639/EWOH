import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ObjectiveWeights,
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
    // CP-SAT 可禁用（合规显式降级）：保持 @Optional，默认值 {} 使必选参数可安全跟在后面。
    @Optional() cpSatConfig: CpSatSolverConfig = {},
    // T02 / P0-1（G7）：Solver 可观测（必选；生产路径始终注入）。
    private readonly metricsService: SchedulerMetricsService,
    // T03 / P1-2（G7）：候选引擎（必选；heuristic 候选生成与端点共享语义）。
    private readonly candidateEngine: CandidateEngineService,
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

  /**
   * 用版本化目标 Profile 生成方案变体（P1-C/§六）。
   * 从 SchedulingPolicyConfig.profiles 读取（替代硬编码数组）；缺省兼容既有 A/B/C：
   * A=ON_TIME（准时优先）、B=WORKLOAD_BALANCE（负荷均衡）、C=BALANCED（综合平衡）。
   * planId 后缀（A/B/C）保持不变，createRun 的 objectiveProfile 筛选无需改动。
   */
  async solveVariants(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2[]> {
    const base = await this.policyService.getActivePolicy();
    const config = await this.policyService.getConfig();
    // 版本化目标 Profile（配置缺省回退内置预设；profileId → 权重缩放，soft objective 专用）。
    const resolved = this.policyService.resolveProfiles(config);
    // 变体投放槽：保持公共行为（A/B/C 三变体；suffix 兼容 createRun 的 planId 后缀筛选）。
    const variantSlots: Array<{ suffix: string; profileId: string }> = [
      { suffix: 'A', profileId: 'ON_TIME' },
      { suffix: 'B', profileId: 'WORKLOAD_BALANCE' },
      { suffix: 'C', profileId: 'BALANCED' },
    ];
    const profiles = variantSlots.map((slot) => {
      const profile = resolved[slot.profileId] ?? resolved.BALANCED;
      const scale = profile.scale;
      const scaleKeys = Object.keys(scale);
      const reason =
        scaleKeys.length === 0
          ? `${profile.label}：沿用版本化策略全部权重（不缩放）`
          : `${profile.label}：${scaleKeys.map((k) => `${k}×${scale[k as keyof ObjectiveWeights]}`).join('、')}`;
      return { suffix: slot.suffix, profileId: slot.profileId, label: profile.label, scale, reason };
    });

    const plans: SchedulingPlanV2[] = [];
    for (const profile of profiles) {
      const variantPolicy: SchedulingPolicy = {
        ...base,
        // Phase 2 / P2-T2：8 权重权威缩放（weights 与兼容旧字段同步缩放；profile 只缩放 soft objective）。
        weights: {
          lateness: base.weights.lateness * (profile.scale.lateness ?? 1),
          travel: base.weights.travel * (profile.scale.travel ?? 1),
          wait: base.weights.wait * (profile.scale.wait ?? 1),
          workload: base.weights.workload * (profile.scale.workload ?? 1),
          station: base.weights.station * (profile.scale.station ?? 1),
          change: base.weights.change * (profile.scale.change ?? 1),
          risk: base.weights.risk * (profile.scale.risk ?? 1),
          energy: base.weights.energy * (profile.scale.energy ?? 1),
        },
        latenessWeight: base.latenessWeight * (profile.scale.lateness ?? 1),
        walkingWeight: base.walkingWeight * (profile.scale.travel ?? 1),
        workloadBalanceWeight:
          base.workloadBalanceWeight * (profile.scale.workload ?? 1),
        stationWaitWeight:
          base.stationWaitWeight * (profile.scale.wait ?? 1),
        changeCostWeight:
          base.changeCostWeight * (profile.scale.change ?? 1),
        riskWeight: base.riskWeight * (profile.scale.risk ?? 1),
        energyWeight: base.energyWeight * (profile.scale.energy ?? 1),
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
          // P1-C（§六）：profileId/profileVersion 一并持久化（DB 无独立列，随 baselineDelta 落库可审计）。
          profileId: profile.profileId,
          profileVersion: base.version,
          weights: {
            latenessWeight: variantPolicy.latenessWeight,
            workloadBalanceWeight: variantPolicy.workloadBalanceWeight,
            walkingWeight: variantPolicy.walkingWeight,
            changeCostWeight: variantPolicy.changeCostWeight,
          },
        },
      };
      // P1-C（§六）：plan 记录版本化 Profile（profileId/profileVersion，与 weights 一起确定性重放）。
      plan.profileId = profile.profileId;
      plan.profileVersion = base.version;
      // Phase 2 / P2-T2：实际投放的 8 权重快照（persistPlan 落库 weightsJson；可审计/确定性重放）。
      plan.weights = variantPolicy.weights;
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