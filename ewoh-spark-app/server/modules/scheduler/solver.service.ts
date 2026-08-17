import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ObjectiveWeights,
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  SolverActivationState,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';
import { RouteCostProvider } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { HeuristicSchedulingSolver } from './heuristic-scheduling-solver';
import { CandidateEngineService } from './candidate-engine.service';
import {
  RuleBasedSchedulingSolver,
  RULE_BASED_SOLVER_VERSION,
} from './rule-based-scheduling-solver';
import {
  MilpSchedulingSolver,
  MILP_SOLVER_VERSION,
} from './milp-scheduling-solver';
import { SchedulingObjectiveEvaluator } from './scheduling-objective-evaluator.service';
import {
  CpSatSchedulingSolver,
  type CpSatSolverConfig,
} from './cp-sat-scheduling-solver';
import { ShadowEvaluatorService } from './prediction/shadow-evaluator.service';
import { OutboxService } from './outbox.service';
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
 * Task 6 / P1：SHADOW 双跑对比结果（heuristic=生产方案；CP-SAT=shadow 对比，isShadow）。
 * flag 关闭时 shadowPlan/comparison 为 null（与现状零行为变化）。
 */
export interface ShadowCompareResult {
  /** 生产方案（heuristic；唯一可批准/派工的对象）。 */
  productionPlan: SchedulingPlanV2;
  /** CP-SAT shadow 对比方案（isShadow；绝不批准/派工）；flag 关闭时为 null。 */
  shadowPlan: SchedulingPlanV2 | null;
  /** 对比摘要（flag 关闭时为 null）。 */
  comparison: {
    productionSolverStatus: string | null;
    shadowSolverStatus: string | null;
    feasibility: { production: boolean; shadow: boolean; diverged: boolean };
    objective: { production: number | null; shadow: number | null };
    violations: { production: number; shadow: number; diverged: boolean };
    runtimeMs: { production: number | null; shadow: number | null };
    solverVersion: { production: string | null; shadow: string | null };
  } | null;
}

/**
 * 求解器薄门面：保持既有公共 API（solve / solveVariants）不变，
 * 内部优先委托给 CP-SAT Worker（不可用时回退到确定性启发式 HeuristicSchedulingSolver）。
 */
@Injectable()
export class SolverService {
  private readonly logger = new Logger(SolverService.name);
  private readonly heuristicSolver: HeuristicSchedulingSolver;
  private readonly cpSatSolver: CpSatSchedulingSolver;
  private readonly ruleBasedSolver: RuleBasedSchedulingSolver;
  private readonly milpSolver: MilpSchedulingSolver;

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
    // Task A / P0：CANARY 自动回滚（canary 归 0；模块内已提供，测试直构时可空）。
    @Optional() private readonly shadowEvaluatorService?: ShadowEvaluatorService,
    // Task A / P0：CANARY 回滚 outbox 审计事件（模块内已提供，测试直构时可空）。
    @Optional() private readonly outboxService?: OutboxService,
    // NO-13d / ADR-053：目标评估器（P0-5 统一评估语义；缺省时 rule-based 直构同款）。
    @Optional() objectiveEvaluator?: SchedulingObjectiveEvaluator,
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
    this.ruleBasedSolver = new RuleBasedSchedulingSolver(
      policyService,
      candidateEngine,
      objectiveEvaluator ?? new SchedulingObjectiveEvaluator(),
    );
    // NO-13i / ADR-058：MILP 求解器（HiGHS WASM 进程内；策略显式选择 milp-v1）。
    this.milpSolver = new MilpSchedulingSolver(
      policyService,
      candidateEngine,
      objectiveEvaluator ?? new SchedulingObjectiveEvaluator(),
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

    // NEST-143 修复（2026-08-17）：三变体顺序 await（3× 全量求解串行耗时）→
    // Promise.all 并行（变体间无共享可变状态：各自独立 policy 快照/求解器实例
    // 无跨调用状态）；结果按 profiles 顺序映射，输出顺序与历史一致（确定性）。
    const plans = await Promise.all(
      profiles.map(async (profile) => {
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
        return plan;
      }),
    );
    return plans;
  }

  /** 单次求解，返回一个完整方案。路由由激活阶梯（OFF/SHADOW/CANARY/PRODUCTION）决定。 */
  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const started = Date.now();
    // NO-13d / ADR-053：策略显式选择 rule-based-v1（差异边界 §9——策略驱动，
    // 不参与 CP-SAT 激活阶梯，亦不隐式回退）。
    const policy = opts.policy ?? (await this.policyService.getActivePolicy());
    let activation: {
      state: SolverActivationState;
      canaryFraction: number;
      orgAllowlist: string[];
      orgAllowlisted: boolean;
    };
    let plan: SchedulingPlanV2;
    if (policy.solverVersion === RULE_BASED_SOLVER_VERSION) {
      activation = { state: 'RULE_BASED', canaryFraction: 0, orgAllowlist: [], orgAllowlisted: false };
      plan = await this.ruleBasedSolver.solve(
        snapshot,
        this.toSchedulingConstraints(constraints),
        opts,
      );
    } else if (policy.solverVersion === MILP_SOLVER_VERSION) {
      // NO-13i / ADR-058：MILP 显式策略选择（差异边界 §9——不参与 CP-SAT 激活阶梯，
      // 亦不隐式回退；solverActivation 如实标记 MILP）。
      activation = { state: 'MILP', canaryFraction: 0, orgAllowlist: [], orgAllowlisted: false };
      plan = await this.milpSolver.solve(
        snapshot,
        this.toSchedulingConstraints(constraints),
        opts,
      );
    } else {
      activation = await this.resolveActivation(opts);
      plan = await this.runByActivation(activation, snapshot, constraints, opts);
    }
    // Task A / P0：solverActivation 审计（state/canaryFraction/orgAllowlisted 随 baselineDelta 落库）。
    plan.baselineDelta = {
      ...(plan.baselineDelta ?? {}),
      solverActivation: {
        state: activation.state,
        canaryFraction: activation.canaryFraction,
        orgAllowlisted: activation.orgAllowlisted,
      },
    };
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
        // NEST-144 修复（2026-08-17）：feasible 判定加 violation==0——仅以
        // assignments 数量覆盖 schedulable 任务数判定会把带硬违例的方案误标
        // feasible（数量达标但存在违规分配/no_eligible_resource 违例）。
        feasible:
          plan.assignments.length >=
            snapshot.tasks.filter(
              (t) => !['completed', 'cancelled'].includes(t.status),
            ).length && (plan.violations?.length ?? 0) === 0,
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

  /** 生产门控（Task A / P0）：EWOH_SOLVER_PRODUCTION_ENABLED === '1' 才允许 CP-SAT 进入生产路径。 */
  private isProductionEnabled(): boolean {
    return process.env.EWOH_SOLVER_PRODUCTION_ENABLED === '1';
  }

  /**
   * 解析激活阶梯（Task A / P0，唯一事实源）。
   * 优先级：EWOH_SOLVER_ACTIVATION 环境变量（非法值 warn + 回退 'OFF'）>
   * SchedulingPolicyConfig.cpSat.activation（parseConfig 缺省 'OFF'）> 'OFF'。
   * CANARY 采样判定：org allowlist 命中即采样；否则确定性哈希 (stableHash(orgId ?? planId) % 1000)/1000 < canaryFraction。
   */
  private async resolveActivation(opts: SolveOptions): Promise<{
    state: SolverActivationState;
    canaryFraction: number;
    orgAllowlist: string[];
    orgAllowlisted: boolean;
  }> {
    const config = await this.policyService.getConfig().catch(() => null);
    const cpSat = config?.cpSat;

    let state: SolverActivationState = 'OFF';
    const envOverride = process.env.EWOH_SOLVER_ACTIVATION;
    if (envOverride !== undefined && envOverride !== '') {
      if (
        envOverride === 'OFF' ||
        envOverride === 'SHADOW' ||
        envOverride === 'CANARY' ||
        envOverride === 'PRODUCTION'
      ) {
        state = envOverride;
      } else {
        this.logger.warn(
          `EWOH_SOLVER_ACTIVATION 非法值 "${envOverride}"（须为 OFF/SHADOW/CANARY/PRODUCTION），回退 'OFF'`,
        );
      }
    } else {
      state = cpSat?.activation ?? 'OFF';
    }

    const canaryFraction =
      typeof cpSat?.canaryFraction === 'number' &&
      Number.isFinite(cpSat.canaryFraction)
        ? Math.min(1, Math.max(0, cpSat.canaryFraction))
        : 0;
    const orgAllowlist = Array.isArray(cpSat?.orgAllowlist)
      ? cpSat.orgAllowlist.filter((o): o is string => typeof o === 'string')
      : [];

    const orgId = opts.orgId ?? null;
    const allowlisted = orgId != null && orgAllowlist.includes(orgId);
    const sampled =
      allowlisted ||
      (canaryFraction > 0 &&
        (this.stableHash(orgId ?? opts.planId) % 1000) / 1000 < canaryFraction);

    return {
      state,
      canaryFraction,
      orgAllowlist,
      orgAllowlisted: state === 'CANARY' ? sampled : false,
    };
  }

  /** 按激活阶梯路由求解（Task A / P0）。 */
  private async runByActivation(
    activation: {
      state: SolverActivationState;
      canaryFraction: number;
      orgAllowlist: string[];
      orgAllowlisted: boolean;
    },
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const schedConstraints = this.toSchedulingConstraints(constraints);
    switch (activation.state) {
      case 'SHADOW':
        // heuristic 生产 + CP-SAT 双跑（isShadow 标记；仅观测，绝不作为生产方案返回）。
        return this.solveShadowActivation(snapshot, schedConstraints, opts);
      case 'CANARY':
        // 采样命中 → CP-SAT 生产路径（失败由 cpSatSolver 回退 heuristic + canary 归 0）；
        // 未采样 → 仅 heuristic（与 OFF 同语义）。
        if (activation.orgAllowlisted) {
          return this.solveCanary(snapshot, schedConstraints, opts);
        }
        return this.heuristicSolver.solve(snapshot, schedConstraints, opts);
      case 'PRODUCTION':
        if (!this.isProductionEnabled()) {
          // fail-closed：生产门禁未开，CP-SAT 结果绝不成为生产方案。
          this.logger.error(
            `PRODUCTION 激活但 EWOH_SOLVER_PRODUCTION_ENABLED!=='1'：fail-closed 回退 heuristic（fallbackReason=production_not_gated）`,
          );
          const plan = await this.heuristicSolver.solve(
            snapshot,
            schedConstraints,
            opts,
          );
          plan.fallbackReason = 'production_not_gated';
          return plan;
        }
        // 生产门禁已开：CP-SAT 首选手（失败内部回退 heuristic，如既有行为）。
        return this.cpSatSolver.solve(snapshot, schedConstraints, opts);
      case 'OFF':
      default:
        // 缺省：仅 heuristic（CP-SAT 不参与任何路径）。
        return this.heuristicSolver.solve(snapshot, schedConstraints, opts);
    }
  }

  /**
   * SHADOW 激活（Task A / P0）：heuristic=生产方案；CP-SAT=shadow 对比（isShadow 标记）。
   * shadow 结果绝不作为生产方案返回；CP-SAT 不可达/超时仅记录，生产方案保持 heuristic。
   */
  private async solveShadowActivation(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const started = Date.now();
    const productionPlan = await this.heuristicSolver.solve(
      snapshot,
      constraints,
      opts,
    );
    let shadowPlan: SchedulingPlanV2 | null = null;
    try {
      shadowPlan = await this.cpSatSolver.solve(snapshot, constraints, opts);
      shadowPlan.status = 'shadow';
      shadowPlan.baselineDelta = {
        ...(shadowPlan.baselineDelta ?? {}),
        shadow: {
          isShadow: true,
          mode: 'cp-sat-shadow-compare',
          comparedWith: 'heuristic',
        },
      };
      this.metricsService.recordRun({
        durationMs: Math.max(Date.now() - started, 0),
        feasible: this.isFeasible(shadowPlan, snapshot),
        solverVersion: shadowPlan.solverVersion,
        solverStatus: shadowPlan.solverStatus,
      });
      this.logger.log(
        `SHADOW double-run: production=${productionPlan.solverStatus ?? '?'} shadow=${shadowPlan.solverStatus ?? '?'} planId=${opts.planId}`,
      );
    } catch (err) {
      this.logger.warn(
        `SHADOW 双跑 CP-SAT 不可达/异常（生产方案保持 heuristic）：${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        this.metricsService.recordRun({
          durationMs: Math.max(Date.now() - started, 0),
          feasible: this.isFeasible(productionPlan, snapshot),
          solverVersion: productionPlan.solverVersion,
          solverStatus: productionPlan.solverStatus,
        });
      } catch (metricsErr) {
        this.logger.warn(
          `shadow metrics recording failed: ${metricsErr instanceof Error ? metricsErr.message : String(metricsErr)}`,
        );
      }
    }
    return productionPlan;
  }

  /**
   * CANARY 激活采样路径（Task A / P0）：CP-SAT 作为生产首选手（cpSatSolver 内部失败回退
   * heuristic 并携带 solverStatus/fallbackReason）。当结果处于 FALLBACK/UNAVAILABLE/TIMEOUT
   * 或求解异常 → 采用 heuristic 回退方案 + canary 归 0 + outbox policy.shadow.canary.rollback
   * （全部 try/catch 守卫，绝不破坏 solve）。
   */
  private async solveCanary(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    try {
      const plan = await this.cpSatSolver.solve(snapshot, constraints, opts);
      if (
        plan.solverStatus === 'FALLBACK' ||
        plan.solverStatus === 'UNAVAILABLE' ||
        plan.solverStatus === 'TIMEOUT'
      ) {
        this.logger.warn(
          `CANARY 采样 CP-SAT 不可用（solverStatus=${plan.solverStatus}）：采纳 heuristic 回退方案 + canary 归 0，planId=${opts.planId}`,
        );
        await this.rollbackCanary(plan.solverStatus ?? 'unknown', opts);
      } else {
        this.logger.log(
          `CANARY 采样 CP-SAT 生产路径（solverStatus=${plan.solverStatus}），planId=${opts.planId}`,
        );
      }
      return plan;
    } catch (err) {
      this.logger.warn(
        `CANARY 采样 CP-SAT 求解异常，回退 heuristic + canary 归 0：${err instanceof Error ? err.message : String(err)}`,
      );
      await this.rollbackCanary('exception', opts);
      return this.heuristicSolver.solve(snapshot, constraints, opts);
    }
  }

  /**
   * CANARY 自动回滚（Task A / P0）：ShadowEvaluatorService.setCanaryFraction(0) +
   * outbox `policy.shadow.canary.rollback` + 指标。全部 try/catch 守卫（绝不抛出）。
   */
  private async rollbackCanary(reason: string, opts: SolveOptions): Promise<void> {
    try {
      this.shadowEvaluatorService?.setCanaryFraction(0);
    } catch (err) {
      this.logger.warn(
        `canary rollback (setCanaryFraction 0) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.outboxService?.enqueue(
        'policy.shadow.canary.rollback',
        opts.planId,
        {
          reasons: [`cpsat_unavailable:${reason}`],
          canaryRolledBack: true,
          planId: opts.planId,
        },
        null,
        undefined,
        { entityType: 'policy', snapshotVersion: opts.snapshotVersion },
      );
    } catch (err) {
      this.logger.warn(
        `canary rollback event enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      this.metricsService.recordPolicyEvent('shadow');
    } catch (err) {
      this.logger.warn(
        `canary rollback metrics failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 确定性稳定哈希（FNV-1a 32-bit；跨进程/重启恒定，供 CANARY 采样）。 */
  private stableHash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Task 6 / P1：SHADOW 双跑（schedulingPolicyConfig.cpSat?.shadowCompare）。
   * - flag 关闭（缺省）：仅生产方案（heuristic 单跑，不调用 CP-SAT）——与现状零行为变化。
   * - flag 开启：同一 snapshot/policy 上同时跑 heuristic（生产方案）+ CP-SAT（shadow 对比），
   *   返回两者与 comparison（feasibility/objective/violations/runtime/solverStatus）；
   *   shadow 结果标记 isShadow，绝不作为生产方案返回（solve() 保持 heuristic 生产方案）。
   * 激活阶梯（OFF→SHADOW→CANARY→PRODUCTION）：当前 feature-status.yaml
   * cpSat.productionEnabled=false，本方法仅用于 SHADOW 观测，绝不派工。
   */
  async solveShadowCompare(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<ShadowCompareResult> {
    const config = await this.policyService.getConfig();
    const shadowCompare = config.cpSat?.shadowCompare ?? false;
    if (!shadowCompare) {
      // 缺省：仅生产方案（heuristic），不跑 CP-SAT 双跑（零行为变化、确定性）。
      const productionPlan = await this.heuristicSolver.solve(
        snapshot,
        this.toSchedulingConstraints(constraints),
        opts,
      );
      return { productionPlan, shadowPlan: null, comparison: null };
    }

    const started = Date.now();
    const productionPlan = await this.heuristicSolver.solve(
      snapshot,
      this.toSchedulingConstraints(constraints),
      opts,
    );
    const shadowPlan = await this.cpSatSolver.solve(
      snapshot,
      this.toSchedulingConstraints(constraints),
      opts,
    );
    // SHADOW 结果标记：status=shadow（PlanService ShadowPlanGuard 拒绝 approve/dispatch/reserve）
    // + baselineDelta.shadow.isShadow=true（审计可解释）。绝不作为生产方案返回。
    shadowPlan.status = 'shadow';
    shadowPlan.baselineDelta = {
      ...(shadowPlan.baselineDelta ?? {}),
      shadow: {
        isShadow: true,
        mode: 'cp-sat-shadow-compare',
        comparedWith: 'heuristic',
      },
    };

    const productionViolations = this.violationSignatures(productionPlan.violations);
    const shadowViolations = this.violationSignatures(shadowPlan.violations);
    const violationsDiverged =
      [...productionViolations].some((v) => !shadowViolations.has(v)) ||
      [...shadowViolations].some((v) => !productionViolations.has(v));
    const productionFeasible = this.isFeasible(productionPlan, snapshot);
    const shadowFeasible = this.isFeasible(shadowPlan, snapshot);
    const comparison = {
      productionSolverStatus: productionPlan.solverStatus ?? null,
      shadowSolverStatus: shadowPlan.solverStatus ?? null,
      feasibility: {
        production: productionFeasible,
        shadow: shadowFeasible,
        diverged: productionFeasible !== shadowFeasible,
      },
      objective: {
        production: productionPlan.objective ?? null,
        shadow: shadowPlan.objective ?? null,
      },
      violations: {
        production: productionPlan.violations.length,
        shadow: shadowPlan.violations.length,
        diverged: violationsDiverged,
      },
      runtimeMs: {
        production: productionPlan.solveDurationMs ?? null,
        shadow: shadowPlan.solveDurationMs ?? null,
      },
      solverVersion: {
        production: productionPlan.solverVersion ?? null,
        shadow: shadowPlan.solverVersion ?? null,
      },
    };

    // 观测埋点（记录/审计用；失败仅记日志，绝不阻断）。
    try {
      this.metricsService.recordRun({
        durationMs: Math.max(Date.now() - started, 0),
        feasible: shadowFeasible,
        solverVersion: shadowPlan.solverVersion,
        solverStatus: shadowPlan.solverStatus,
      });
    } catch (err) {
      this.logger.warn(
        `shadow compare metrics recording failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(
      `SHADOW compare: production=${productionPlan.solverStatus ?? '?'} shadow=${shadowPlan.solverStatus ?? '?'} ` +
        `violations=${productionPlan.violations.length}/${shadowPlan.violations.length} ` +
        `diverged=${violationsDiverged} planId=${opts.planId} snapshot=${snapshot.snapshotVersion}`,
    );
    return { productionPlan, shadowPlan, comparison };
  }

  /** 硬约束违例签名集合（type 优先；无 type 退化为整体序列化），供分歧检测。 */
  private violationSignatures(violations: Array<Record<string, unknown>>): Set<string> {
    const sigs = new Set<string>();
    for (const v of violations ?? []) {
      const t = typeof v === 'object' && v != null ? v['type'] : undefined;
      sigs.add(typeof t === 'string' && t ? `type:${t}` : `raw:${JSON.stringify(v)}`);
    }
    return sigs;
  }

  /**
   * 可分配性：assignments 覆盖所有非终态任务（与 recordRun 的 feasible 语义一致）。
   * R2-SCH-019 / NEST-144 残留（2026-08-17）：补齐 violation==0 判定——recordRun
   * 侧 feasible 已含硬违例检查，isFeasible 缺失同一条件会把带违例的方案在
   * SHADOW/compare 观测中误标 feasible（双源判定不一致）。
   */
  private isFeasible(plan: SchedulingPlanV2, snapshot: WorldStateSnapshot): boolean {
    const schedulable = snapshot.tasks.filter(
      (t) => !['completed', 'cancelled'].includes(t.status),
    ).length;
    return (
      plan.assignments.length >= schedulable && (plan.violations?.length ?? 0) === 0
    );
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

  /**
   * 局部重排影响任务数（scheduler_partial_replan_affected 的数值来源，Task B P0 统一语义）。
   * - 局部重排（partial replan）：opts.affectedTaskIds 非空 → 返回其长度（真实影响集
   *   ReplanImpact.affectedTaskIds，来自 impact-propagation；不随 partial snapshot 的
   *   frozen 任务数膨胀）。
   * - 全量重排（full replan，affectedTaskIds 缺省）：按快照任务数近似（保持既有语义）。
   */
  private affectedTaskCount(
    snapshot: WorldStateSnapshot,
    opts: SolveOptions,
  ): number {
    if (Array.isArray(opts.affectedTaskIds) && opts.affectedTaskIds.length > 0) {
      return opts.affectedTaskIds.length;
    }
    return snapshot.tasks.length;
  }

  /**
   * 将遗留的开放字符串约束转换为统一 SchedulingConstraint。
   * NEST-145 修复（2026-08-17）：去除 `as unknown as` 类型逃逸——runtime
   * 形状校验（type 必须是非空 string；taskId/personId/deviceId/stationId/
   * zoneId 仅接受 string；startMs/endMs 仅接受有限数），非法条目丢弃并留痕。
   */
  private toSchedulingConstraints(
    constraints: SolverConstraint[],
  ): SchedulingConstraint[] {
    const out: SchedulingConstraint[] = [];
    for (const c of constraints) {
      const rec = c as unknown as Record<string, unknown>;
      if (typeof rec.type !== 'string' || rec.type.trim() === '') {
        this.logger.warn(
          `toSchedulingConstraints: drop constraint without valid type (${JSON.stringify(rec).slice(0, 80)})`,
        );
        continue;
      }
      const strOrUndef = (v: unknown): string | undefined =>
        typeof v === 'string' ? v : undefined;
      const numOrUndef = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      // NEST-145：保留原记录全部字段（value/hard/snapshotVersion 等扩展维度
      // 由消费方读取，如 heuristic 的 MAX_WORKLOAD c.value）——仅对核心
      // identity 字段做 runtime 规整，不截断未知字段。
      out.push({
        ...rec,
        id: strOrUndef(rec.id),
        type: rec.type,
        taskId: strOrUndef(rec.taskId),
        personId: strOrUndef(rec.personId),
        deviceId: strOrUndef(rec.deviceId),
        stationId: strOrUndef(rec.stationId),
        zoneId: strOrUndef(rec.zoneId),
        startMs: numOrUndef(rec.startMs),
        endMs: numOrUndef(rec.endMs),
        operator: strOrUndef(rec.operator),
        reason: strOrUndef(rec.reason),
      } as SchedulingConstraint);
    }
    return out;
  }
}