import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc } from 'drizzle-orm';
import { ewohSchedulingPolicy } from '@server/database/schema';
import type {
  ObjectiveWeights,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  SchedulingPolicyVersionSummary,
} from '@shared/api.interface';

/** 求解器版本：同一策略版本 + 求解器版本可确定性重放。 */
const DEFAULT_SOLVER_VERSION = 'heuristic-v2';

/**
 * 默认目标权重常量（Phase 2 / P2-T2）：weights_json 缺失时的兜底，不再魔法数派生。
 * 与历史默认一致（lateness=deadlineRisk*3=3 / travel=euclidean=1 / wait=1 / workload=1 /
 * station=1 / change=0.5 / risk=highRisk/2=1 / energy=minBattery/30=0.5）。
 */
const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
  lateness: 3,
  travel: 1,
  wait: 1,
  workload: 1,
  station: 1,
  change: 0.5,
  risk: 1,
  energy: 0.5,
};

/** 无生效策略时的硬编码默认策略（消除 magic numbers 的兜底）。 */
const DEFAULT_POLICY: SchedulingPolicy = {
  version: 1,
  solverVersion: DEFAULT_SOLVER_VERSION,
  weights: DEFAULT_OBJECTIVE_WEIGHTS,
  latenessWeight: DEFAULT_OBJECTIVE_WEIGHTS.lateness,
  walkingWeight: DEFAULT_OBJECTIVE_WEIGHTS.travel,
  workloadBalanceWeight: DEFAULT_OBJECTIVE_WEIGHTS.workload,
  stationWaitWeight: DEFAULT_OBJECTIVE_WEIGHTS.wait,
  changeCostWeight: DEFAULT_OBJECTIVE_WEIGHTS.change,
  riskWeight: DEFAULT_OBJECTIVE_WEIGHTS.risk,
  energyWeight: DEFAULT_OBJECTIVE_WEIGHTS.energy,
};

/** 无生效配置时的硬编码默认配置。 */
const DEFAULT_CONFIG: SchedulingPolicyConfig = {
  configVersion: 1,
  minBatteryPct: 15,
  maxContinuousLoad: 0.9,
  defaultTaskDurationMs: 1_800_000,
  horizonMinutes: 480,
  walkingSpeedMps: 1,
  euclideanDistanceWeight: 1,
  congestedFactor: 1.5,
  blockedFactor: 2,
  highRiskFactor: 2,
  mediumRiskFactor: 1.3,
  triggerCooldownMs: 30_000,
  priority: {
    deadlineRiskWeight: 1,
    waitingAgeWeight: 0.5,
    eventSeverityWeight: 1,
    productionImpactWeight: 1,
    downstreamBlockingWeight: 1,
    manualBoostWeight: 1,
    agingBaseMs: 3_600_000,
  },
  // T03 / P1-4（G3）：魔法数入策略——preferenceBonusMinutes 仅存在于默认配置常量，
  // 不再散落 solver 代码。
  preferenceBonusMinutes: 30,
  setupMinutes: 15,
  stationCapacityEnforced: true,
  // --- Incremental Replan V2（M01，08 §3/§6/§7/§11）：缺省=现状 ---
  replan: {
    replanDebounceMs: 5_000,
    minimumReplanIntervalMs: 30_000,
    maximumReplansPerWindow: 12,
    conflictAggregationWindowMs: 60_000,
    maxPropagationDepth: 3,
    maxAffectedTasks: 200,
  },
  replanApproval: {
    autoMaxAffectedRatio: 0.5,
    autoMaxChurnRatio: 0.4,
    requireApprovalOnSafetyCritical: true,
    requireApprovalOnHumanLock: true,
  },
  churn: {
    // 缺省=现状回归：person 变更与 assignment 移除按 weights.change，其余维度 0。
    personChangePenalty: DEFAULT_OBJECTIVE_WEIGHTS.change,
    deviceChangePenalty: 0,
    stationChangePenalty: 0,
    startTimeShiftPenalty: 0,
    sequenceChangePenalty: 0,
    assignmentRemovalPenalty: DEFAULT_OBJECTIVE_WEIGHTS.change,
    assignmentAdditionPenalty: 0,
  },
  prediction: {
    canaryFractions: [0, 0.05, 0.2, 0.5, 1],
    autoRollbackOn: {
      maxAbsoluteError: 0.25,
      maxFallbackRate: 0.5,
      minCoverage: 0.8,
    },
  },
};

/**
 * 版本化调度策略服务：集中所有调度参数，消除 magic numbers。
 * 从 ewohSchedulingPolicy 表中读取/保存版本化配置，
 * 并据此构建带目标权重的 SchedulingPolicy。
 */
@Injectable()
export class SchedulingPolicyService {
  private readonly logger = new Logger(SchedulingPolicyService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 读取当前生效策略（active=true，按 configVersion 降序取最新）。
   * 若无生效行则返回硬编码默认策略。
   */
  async getActivePolicy(): Promise<SchedulingPolicy> {
    const row = await this.findActiveRow();
    if (!row) {
      this.logger.warn('no active scheduling policy row; using default policy');
      return DEFAULT_POLICY;
    }
    const config = this.parseConfig(row.configJson);
    return this.buildPolicy(config, row.configVersion, row.weightsJson);
  }

  /**
   * 读取当前生效配置（active=true 最新）。若无则返回默认配置。
   */
  async getConfig(): Promise<SchedulingPolicyConfig> {
    const row = await this.findActiveRow();
    if (!row) {
      this.logger.warn('no active scheduling policy row; using default config');
      return DEFAULT_CONFIG;
    }
    return this.parseConfig(row.configJson);
  }

  /** 读取指定 configVersion 的策略。不存在返回 null。 */
  async getPolicy(configVersion: number): Promise<SchedulingPolicy | null> {
    const row = await this.findByVersion(configVersion);
    if (!row) return null;
    const config = this.parseConfig(row.configJson);
    return this.buildPolicy(config, row.configVersion, row.weightsJson);
  }

  /** 读取指定版本的 active 状态（Phase 4 / P4-T2：activate 守卫）。不存在返回 null。 */
  async getPolicyVersionStatus(
    configVersion: number,
  ): Promise<{ configVersion: number; active: boolean } | null> {
    const row = await this.findByVersion(configVersion);
    return row ? { configVersion: row.configVersion, active: row.active } : null;
  }

  /** 读取指定 configVersion 的配置。不存在返回 null。 */
  async getConfigByVersion(
    configVersion: number,
  ): Promise<SchedulingPolicyConfig | null> {
    const row = await this.findByVersion(configVersion);
    if (!row) return null;
    return this.parseConfig(row.configJson);
  }

  /**
   * Replan V2（M02）：解析 ReplanConfig（缺省回退 DEFAULT_CONFIG.replan）。
   * 供 ReplanCoordinatorService 风暴守卫/传播上限读取；配置全可选。
   */
  async resolveReplanConfig(
    config?: SchedulingPolicyConfig | null,
  ): Promise<SchedulingPolicyConfig['replan']> {
    const effective = config ?? (await this.getConfig());
    return {
      ...DEFAULT_CONFIG.replan,
      ...(effective.replan ?? {}),
    };
  }

  /**
   * Replan V2（M02）：解析 ReplanApprovalConfig（缺省回退 DEFAULT_CONFIG.replanApproval）。
   * 供 M03 审批政策读取；M02 已提供访问器。
   */
  async resolveReplanApprovalConfig(
    config?: SchedulingPolicyConfig | null,
  ): Promise<SchedulingPolicyConfig['replanApproval']> {
    const effective = config ?? (await this.getConfig());
    return {
      ...DEFAULT_CONFIG.replanApproval,
      ...(effective.replanApproval ?? {}),
    };
  }

  /** Replan V2（M02）：同步访问默认 ReplanConfig（供测试/无 DB 场景）。 */
  defaultReplanConfig(): NonNullable<SchedulingPolicyConfig['replan']> {
    return { ...DEFAULT_CONFIG.replan };
  }

  /**
   * 保存新配置：configVersion 取当前最大值 + 1，active=true，
   * 并将此前所有 active 行置为 active=false。
   */
  async savePolicy(
    config: SchedulingPolicyConfig,
    orgId: string | null,
    updatedBy: string,
  ): Promise<SchedulingPolicyConfig> {
    try {
      const nextVersion = await this.computeNextVersion();

      const toSave: SchedulingPolicyConfig = {
        ...config,
        configVersion: nextVersion,
      };

      await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: false })
        .where(eq(ewohSchedulingPolicy.active, true));

      await this.db.insert(ewohSchedulingPolicy).values({
        configVersion: nextVersion,
        configJson: toSave as unknown as typeof toSave,
        // Phase 2 / P2-T2：8 权重权威列（与 configJson.weights 并行，双写保持兼容）。
        weightsJson: toSave.weights ?? null,
        active: true,
        orgId,
        updatedBy,
      });

      this.logger.log(
        `saved scheduling policy v${nextVersion} by ${updatedBy}`,
      );
      return toSave;
    } catch (err) {
      this.logger.error(
        `failed to save scheduling policy (org=${orgId}, by=${updatedBy})`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  /**
   * 列出全部策略版本（含 active 标志、操作人、创建时间），按 configVersion 降序。
   * 供命令图「策略版本」面板展示当前生效版本与候选版本。
   */
  async listVersions(): Promise<SchedulingPolicyVersionSummary[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .orderBy(desc(ewohSchedulingPolicy.configVersion));
    return rows.map((r) => ({
      configVersion: r.configVersion,
      active: r.active,
      updatedBy: r.updatedBy ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
    }));
  }

  /**
   * 注册一个候选策略版本（Task 6）。
   * 以新 configVersion 持久化为 active=false 的新行，**绝不**自动激活。
   * 只有显式调用 activatePolicyVersion（人工审批）才会翻转生产策略。
   */
  async registerCandidatePolicy(
    config: SchedulingPolicyConfig,
    orgId: string | null,
    updatedBy: string,
  ): Promise<SchedulingPolicyConfig> {
    const nextVersion = await this.computeNextVersion();
    const toSave: SchedulingPolicyConfig = {
      ...config,
      configVersion: nextVersion,
    };
    await this.db.insert(ewohSchedulingPolicy).values({
      configVersion: nextVersion,
      configJson: toSave as unknown as typeof toSave,
      // Phase 2 / P2-T2：8 权重权威列（双写保持兼容）。
      weightsJson: toSave.weights ?? null,
      active: false,
      orgId,
      updatedBy,
    });
    this.logger.log(
      `registered candidate scheduling policy v${nextVersion} by ${updatedBy} (inactive)`,
    );
    return toSave;
  }

  /**
   * 激活指定版本（Task 6）：将目标行 active=true，其余行 active=false。
   * 这是唯一翻转生产策略的路径，调用方负责人工审批与审计。
   */
  async activatePolicyVersion(
    configVersion: number,
    orgId: string | null,
    updatedBy: string,
  ): Promise<SchedulingPolicyConfig> {
    const row = await this.findByVersion(configVersion);
    if (!row) {
      throw new NotFoundException(
        `Scheduling policy version ${configVersion} not found`,
      );
    }
    // 1) 解除当前生效版本。
    await this.db
      .update(ewohSchedulingPolicy)
      .set({ active: false })
      .where(eq(ewohSchedulingPolicy.active, true));
    // 2) 激活目标版本。
    await this.db
      .update(ewohSchedulingPolicy)
      .set({ active: true, updatedBy, orgId, updatedAt: new Date() })
      .where(eq(ewohSchedulingPolicy.configVersion, configVersion));
    this.logger.log(`activated scheduling policy v${configVersion} by ${updatedBy}`);
    const config = this.parseConfig(row.configJson);
    return { ...config, configVersion };
  }

  /** 查询当前生效行（active=true 最新一条）。 */
  private async findActiveRow() {
    const rows = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.active, true))
      .orderBy(desc(ewohSchedulingPolicy.configVersion))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 查询指定 configVersion 的行。 */
  private async findByVersion(configVersion: number) {
    const rows = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.configVersion, configVersion))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 计算下一个 configVersion（当前最大值 + 1，无数据则从 1 开始）。 */
  private async computeNextVersion(): Promise<number> {
    const rows = await this.db
      .select({ configVersion: ewohSchedulingPolicy.configVersion })
      .from(ewohSchedulingPolicy)
      .orderBy(desc(ewohSchedulingPolicy.configVersion))
      .limit(1);
    const max = rows[0]?.configVersion ?? 0;
    return max + 1;
  }

  /** 解析 jsonb 为 SchedulingPolicyConfig（T03：runtime validation，缺省回退默认值）。 */
  private parseConfig(configJson: unknown): SchedulingPolicyConfig {
    if (!configJson || typeof configJson !== 'object') return DEFAULT_CONFIG;
    const c = configJson as Partial<SchedulingPolicyConfig>;
    // 仅透传合法字段；缺失/非法回退默认（绝不 as unknown as 逃逸类型检查）。
    return {
      configVersion: this.num(c.configVersion, DEFAULT_CONFIG.configVersion),
      minBatteryPct: this.num(c.minBatteryPct, DEFAULT_CONFIG.minBatteryPct),
      maxContinuousLoad: this.num(c.maxContinuousLoad, DEFAULT_CONFIG.maxContinuousLoad),
      defaultTaskDurationMs: this.num(c.defaultTaskDurationMs, DEFAULT_CONFIG.defaultTaskDurationMs),
      horizonMinutes: this.num(c.horizonMinutes, DEFAULT_CONFIG.horizonMinutes),
      walkingSpeedMps: this.num(c.walkingSpeedMps, DEFAULT_CONFIG.walkingSpeedMps),
      euclideanDistanceWeight: this.num(c.euclideanDistanceWeight, DEFAULT_CONFIG.euclideanDistanceWeight),
      congestedFactor: this.num(c.congestedFactor, DEFAULT_CONFIG.congestedFactor),
      blockedFactor: this.num(c.blockedFactor, DEFAULT_CONFIG.blockedFactor),
      highRiskFactor: this.num(c.highRiskFactor, DEFAULT_CONFIG.highRiskFactor),
      mediumRiskFactor: this.num(c.mediumRiskFactor, DEFAULT_CONFIG.mediumRiskFactor),
      triggerCooldownMs: this.num(c.triggerCooldownMs, DEFAULT_CONFIG.triggerCooldownMs),
      priority: {
        deadlineRiskWeight: this.num(c.priority?.deadlineRiskWeight, DEFAULT_CONFIG.priority.deadlineRiskWeight),
        waitingAgeWeight: this.num(c.priority?.waitingAgeWeight, DEFAULT_CONFIG.priority.waitingAgeWeight),
        eventSeverityWeight: this.num(c.priority?.eventSeverityWeight, DEFAULT_CONFIG.priority.eventSeverityWeight),
        productionImpactWeight: this.num(c.priority?.productionImpactWeight, DEFAULT_CONFIG.priority.productionImpactWeight),
        downstreamBlockingWeight: this.num(c.priority?.downstreamBlockingWeight, DEFAULT_CONFIG.priority.downstreamBlockingWeight),
        manualBoostWeight: this.num(c.priority?.manualBoostWeight, DEFAULT_CONFIG.priority.manualBoostWeight),
        agingBaseMs: this.num(c.priority?.agingBaseMs, DEFAULT_CONFIG.priority.agingBaseMs),
      },
      weights: (c.weights ?? undefined) as SchedulingPolicyConfig['weights'],
      // T03 / P1-4：魔法数入策略透传（缺省默认常量）。
      preferenceBonusMinutes: this.num(c.preferenceBonusMinutes, DEFAULT_CONFIG.preferenceBonusMinutes),
      setupMinutes: this.num(c.setupMinutes, DEFAULT_CONFIG.setupMinutes),
      stationCapacityEnforced:
        c.stationCapacityEnforced === undefined
          ? DEFAULT_CONFIG.stationCapacityEnforced
          : Boolean(c.stationCapacityEnforced),
      // --- Incremental Replan V2（M01）：可选块透传，缺省回退默认（08 §3/§6/§7/§11） ---
      replan: {
        replanDebounceMs: this.num(c.replan?.replanDebounceMs, DEFAULT_CONFIG.replan.replanDebounceMs),
        minimumReplanIntervalMs: this.num(
          c.replan?.minimumReplanIntervalMs,
          DEFAULT_CONFIG.replan.minimumReplanIntervalMs,
        ),
        maximumReplansPerWindow: this.num(
          c.replan?.maximumReplansPerWindow,
          DEFAULT_CONFIG.replan.maximumReplansPerWindow,
        ),
        conflictAggregationWindowMs: this.num(
          c.replan?.conflictAggregationWindowMs,
          DEFAULT_CONFIG.replan.conflictAggregationWindowMs,
        ),
        maxPropagationDepth: this.num(c.replan?.maxPropagationDepth, DEFAULT_CONFIG.replan.maxPropagationDepth),
        maxAffectedTasks: this.num(c.replan?.maxAffectedTasks, DEFAULT_CONFIG.replan.maxAffectedTasks),
      },
      replanApproval: {
        autoMaxAffectedRatio: this.num(
          c.replanApproval?.autoMaxAffectedRatio,
          DEFAULT_CONFIG.replanApproval.autoMaxAffectedRatio,
        ),
        autoMaxChurnRatio: this.num(
          c.replanApproval?.autoMaxChurnRatio,
          DEFAULT_CONFIG.replanApproval.autoMaxChurnRatio,
        ),
        requireApprovalOnSafetyCritical:
          c.replanApproval?.requireApprovalOnSafetyCritical === undefined
            ? DEFAULT_CONFIG.replanApproval.requireApprovalOnSafetyCritical
            : Boolean(c.replanApproval.requireApprovalOnSafetyCritical),
        requireApprovalOnHumanLock:
          c.replanApproval?.requireApprovalOnHumanLock === undefined
            ? DEFAULT_CONFIG.replanApproval.requireApprovalOnHumanLock
            : Boolean(c.replanApproval.requireApprovalOnHumanLock),
      },
      churn: {
        personChangePenalty: this.num(c.churn?.personChangePenalty, DEFAULT_CONFIG.churn.personChangePenalty),
        deviceChangePenalty: this.num(c.churn?.deviceChangePenalty, DEFAULT_CONFIG.churn.deviceChangePenalty),
        stationChangePenalty: this.num(c.churn?.stationChangePenalty, DEFAULT_CONFIG.churn.stationChangePenalty),
        startTimeShiftPenalty: this.num(c.churn?.startTimeShiftPenalty, DEFAULT_CONFIG.churn.startTimeShiftPenalty),
        sequenceChangePenalty: this.num(c.churn?.sequenceChangePenalty, DEFAULT_CONFIG.churn.sequenceChangePenalty),
        assignmentRemovalPenalty: this.num(
          c.churn?.assignmentRemovalPenalty,
          DEFAULT_CONFIG.churn.assignmentRemovalPenalty,
        ),
        assignmentAdditionPenalty: this.num(
          c.churn?.assignmentAdditionPenalty,
          DEFAULT_CONFIG.churn.assignmentAdditionPenalty,
        ),
      },
      prediction: {
        canaryFractions: Array.isArray(c.prediction?.canaryFractions)
          ? c.prediction!.canaryFractions!
          : DEFAULT_CONFIG.prediction.canaryFractions,
        autoRollbackOn: {
          maxAbsoluteError: this.num(
            c.prediction?.autoRollbackOn?.maxAbsoluteError,
            DEFAULT_CONFIG.prediction.autoRollbackOn.maxAbsoluteError,
          ),
          maxFallbackRate: this.num(
            c.prediction?.autoRollbackOn?.maxFallbackRate,
            DEFAULT_CONFIG.prediction.autoRollbackOn.maxFallbackRate,
          ),
          minCoverage: this.num(
            c.prediction?.autoRollbackOn?.minCoverage,
            DEFAULT_CONFIG.prediction.autoRollbackOn.minCoverage,
          ),
        },
      },
    };
  }

  /**
   * 解析 8 权重权威对象（Phase 2 / P2-T2）。
   * 优先级：ewoh_scheduling_policy.weights_json 列（权威）> config.weights 完整 8 项 >
   * 旧配置子集（workloadBalance/stationWait/changeCost/energy）兼容映射 > 默认常量。
   * 不再魔法数派生（去掉 deadlineRiskWeight*3 / highRiskFactor/2 / minBatteryPct/30 之类）。
   */
  private resolveWeights(
    config: SchedulingPolicyConfig,
    weightsJson: unknown = null,
  ): ObjectiveWeights {
    const w = weightsJson ?? config.weights;
    if (w && typeof w === 'object' && 'lateness' in w) {
      const full = w as ObjectiveWeights;
      return {
        lateness: this.num(full.lateness, DEFAULT_OBJECTIVE_WEIGHTS.lateness),
        travel: this.num(full.travel, DEFAULT_OBJECTIVE_WEIGHTS.travel),
        wait: this.num(full.wait, DEFAULT_OBJECTIVE_WEIGHTS.wait),
        workload: this.num(full.workload, DEFAULT_OBJECTIVE_WEIGHTS.workload),
        station: this.num(full.station, DEFAULT_OBJECTIVE_WEIGHTS.station),
        change: this.num(full.change, DEFAULT_OBJECTIVE_WEIGHTS.change),
        risk: this.num(full.risk, DEFAULT_OBJECTIVE_WEIGHTS.risk),
        energy: this.num(full.energy, DEFAULT_OBJECTIVE_WEIGHTS.energy),
      };
    }
    // 旧配置子集兼容映射（向后兼容）。
    const legacy = (w ?? {}) as {
      workloadBalance?: number;
      stationWait?: number;
      changeCost?: number;
      energy?: number;
    };
    return {
      lateness: DEFAULT_OBJECTIVE_WEIGHTS.lateness,
      travel: DEFAULT_OBJECTIVE_WEIGHTS.travel,
      wait: this.num(legacy.stationWait, DEFAULT_OBJECTIVE_WEIGHTS.wait),
      workload: this.num(legacy.workloadBalance, DEFAULT_OBJECTIVE_WEIGHTS.workload),
      station: DEFAULT_OBJECTIVE_WEIGHTS.station,
      change: this.num(legacy.changeCost, DEFAULT_OBJECTIVE_WEIGHTS.change),
      risk: DEFAULT_OBJECTIVE_WEIGHTS.risk,
      energy: this.num(legacy.energy, DEFAULT_OBJECTIVE_WEIGHTS.energy),
    };
  }

  private num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /**
   * 基于配置构建 SchedulingPolicy：8 权重权威对象 + 旧字段兼容别名，
   * version 与配置版本绑定，solverVersion 固定。
   */
  private buildPolicy(
    config: SchedulingPolicyConfig,
    version: number,
    weightsJson?: unknown,
  ): SchedulingPolicy {
    const weights = this.resolveWeights(config, weightsJson);
    return {
      version,
      solverVersion: DEFAULT_SOLVER_VERSION,
      weights,
      latenessWeight: weights.lateness,
      walkingWeight: weights.travel,
      workloadBalanceWeight: weights.workload,
      stationWaitWeight: weights.wait,
      changeCostWeight: weights.change,
      riskWeight: weights.risk,
      energyWeight: weights.energy,
    };
  }
}