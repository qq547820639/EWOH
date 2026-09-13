import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, and, or, isNull } from 'drizzle-orm';
import { ewohSchedulingPolicy } from '@server/database/schema';
import { projectPolicyActivationDecision } from './decision-projection';
import type { DecisionRecord } from '@shared/decision';
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

/**
 * 内置版本化目标 Profile 预设（Phase 1 / P1-C，§六）。
 * 语义兼容既有 solveVariants 硬编码 A/B/C：A=ON_TIME（lateness×3、change×0.5）、
 * B=WORKLOAD_BALANCE（workload×3、travel×1.5、lateness×0.5）、C=BALANCED（不缩放）。
 * profile 只作用于 soft objective 权重缩放，绝不改变 hard constraints。
 */
const DEFAULT_PROFILES: Record<
  string,
  { label: string; scale: Partial<ObjectiveWeights> }
> = {
  ON_TIME: { label: '准时优先', scale: { lateness: 3, change: 0.5 } },
  PRODUCTION_IMPACT: {
    label: '生产影响优先',
    scale: { lateness: 2, change: 1 },
  },
  WORKLOAD_BALANCE: {
    label: '负荷均衡',
    scale: { workload: 3, travel: 1.5, lateness: 0.5 },
  },
  TRAVEL_MIN: { label: '路程最短', scale: { travel: 3, lateness: 0.8 } },
  MIN_CHURN: { label: '最小扰动', scale: { change: 3, travel: 0.5, lateness: 0.7 } },
  BALANCED: { label: '综合平衡', scale: {} },
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
    maxChangedAssignments: 20,
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
  // Phase 1 / P1-C（§六）：版本化目标 Profile 预设（缺省=内置；配置可覆盖/新增）。
  profiles: DEFAULT_PROFILES,
  prediction: {
    canaryFractions: [0, 0.05, 0.2, 0.5, 1],
    autoRollbackOn: {
      maxAbsoluteError: 0.25,
      maxFallbackRate: 0.5,
      minCoverage: 0.8,
    },
    // ADR-056 消费侧激活开关：缺省 off（求解器行为逐字节不变，见 shared/scheduler.ts 注释）。
    durationModelMode: 'off' as const,
  },
  // --- CP-SAT 激活阶梯（Task A / P0）：缺省 OFF（仅 heuristic 生产；CP-SAT 不参与任何路径） ---
  cpSat: {
    activation: 'OFF',
    canaryFraction: 0,
    orgAllowlist: [],
    shadowCompare: false,
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

  /**
   * 性能优化（2026-08-21）：active policy 内存缓存 + TTL。
   * 每次调度请求 10-20+ 次 getActivePolicy/getConfig 调用全部命中同一行，
   * 30s TTL 覆盖单次请求生命周期且与策略变更频率（人工操作）一致。
   * savePolicy/activatePolicyVersion 时主动失效缓存。
   */
  private static readonly CACHE_TTL_MS = Number(
    process.env.EWOH_POLICY_CACHE_TTL_MS || 30_000,
  );
  private activeRowCache = new Map<
    string,
    { row: Awaited<ReturnType<SchedulingPolicyService['findActiveRow']>>; expiresAt: number }
  >();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 读取当前生效策略（active=true，按 configVersion 降序取最新）。
   * 若无生效行则返回硬编码默认策略。
   * NEST-105（2026-08-17）：orgId 提供时按 org 过滤（本 org + NULL 存量全局行），
   * 杜绝 getActivePolicy 返回他租户策略；缺省 = 系统后台流（GUC/RLS 兜底）。
   */
  async getActivePolicy(orgId?: string | null): Promise<SchedulingPolicy> {
    const row = await this.findActiveRow(orgId);
    if (!row) {
      this.logger.warn('no active scheduling policy row; using default policy');
      return DEFAULT_POLICY;
    }
    const config = this.parseConfig(row.configJson);
    return this.buildPolicy(config, row.configVersion, row.weightsJson);
  }

  /**
   * 读取当前生效配置（active=true 最新）。若无则返回默认配置。
   * NEST-105：同 getActivePolicy，orgId 提供时按 org 过滤。
   */
  async getConfig(orgId?: string | null): Promise<SchedulingPolicyConfig> {
    const row = await this.findActiveRow(orgId);
    if (!row) {
      this.logger.warn('no active scheduling policy row; using default config');
      return DEFAULT_CONFIG;
    }
    return this.parseConfig(row.configJson);
  }

  /**
   * 读取指定 configVersion 的策略。不存在返回 null。
   * R2-SSV-01（2026-08-17）：configVersion 已按 org 作用域递增（NEST-165），
   * 版本读取必须带 org 条件（本 org + NULL 全局行）——否则他租户同版本号行
   * 会被命中（策略参数跨租户读取）。
   */
  async getPolicy(
    configVersion: number,
    orgId?: string | null,
  ): Promise<SchedulingPolicy | null> {
    const row = await this.findByVersion(configVersion, orgId);
    if (!row) return null;
    const config = this.parseConfig(row.configJson);
    return this.buildPolicy(config, row.configVersion, row.weightsJson);
  }

  /** 读取指定版本的 active 状态（Phase 4 / P4-T2：activate 守卫）。不存在返回 null。R2-SSV-01：org 条件。 */
  async getPolicyVersionStatus(
    configVersion: number,
    orgId?: string | null,
  ): Promise<{ configVersion: number; active: boolean } | null> {
    const row = await this.findByVersion(configVersion, orgId);
    return row ? { configVersion: row.configVersion, active: row.active } : null;
  }

  /** 读取指定 configVersion 的配置。不存在返回 null。R2-SSV-01：org 条件。 */
  async getConfigByVersion(
    configVersion: number,
    orgId?: string | null,
  ): Promise<SchedulingPolicyConfig | null> {
    const row = await this.findByVersion(configVersion, orgId);
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
   * Phase 1 / P1-C（§六）：解析版本化目标 Profile。
   * 返回归一化 Record<profileId, { label, scale }>：
   * - 配置缺省（无 profiles）→ 内置 6 预设（DEFAULT_PROFILES）；
   * - 配置与内置合并：配置覆盖同名 profile 的 label/scale，并可新增 profileId；
   * - 始终保证 BALANCED 存在（缺省=不缩放，兜底）。
   * profile 只作用于 soft objective 权重缩放，绝不改变 hard constraints。
   */
  resolveProfiles(
    config?: SchedulingPolicyConfig | null,
  ): Record<string, { label: string; scale: Partial<ObjectiveWeights> }> {
    const effective = config ?? DEFAULT_CONFIG;
    const configured = effective.profiles ?? {};
    const merged: Record<
      string,
      { label: string; scale: Partial<ObjectiveWeights> }
    > = {};
    for (const [id, preset] of Object.entries(DEFAULT_PROFILES)) {
      const override = configured[id];
      merged[id] = override
        ? {
            label: override.label ?? preset.label,
            scale: { ...preset.scale, ...(override.scale ?? {}) },
          }
        : preset;
    }
    for (const [id, override] of Object.entries(configured)) {
      if (!merged[id]) {
        merged[id] = {
          label: override.label,
          scale: { ...(override.scale ?? {}) },
        };
      }
    }
    if (!merged.BALANCED) merged.BALANCED = DEFAULT_PROFILES.BALANCED;
    return merged;
  }

  /**
   * 保存新配置：configVersion 取当前最大值 + 1，active=true，
   * 并将此前所有 active 行置为 active=false。
   * NEST-104（2026-08-17）：deactivate 作用域按 org 收敛——orgId 非空时仅
   * 归档本 org 的 active 行；orgId 为空（系统/全局策略路径）仅归档 NULL 全局行。
   * 绝不跨租户归档他 org 的生效策略。
   */
  async savePolicy(
    config: SchedulingPolicyConfig,
    orgId: string | null,
    updatedBy: string,
  ): Promise<SchedulingPolicyConfig> {
    try {
      const nextVersion = await this.computeNextVersion(orgId);

      const toSave: SchedulingPolicyConfig = {
        ...config,
        configVersion: nextVersion,
      };

      // NO-13o / ADR-064：直接保存即激活路径的决策留痕（reason 缺省
      // 'policy-save-activated'；缺口显式留 NULL 不阻断主流程）。
      const decisionJson = this.projectPolicyActivationDecision(
        nextVersion, orgId, updatedBy, 'policy-save-activated',
      );

      await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: false })
        .where(
          and(
            eq(ewohSchedulingPolicy.active, true),
            this.orgScopeCondition(orgId),
          ),
        );

      await this.db.insert(ewohSchedulingPolicy).values({
        configVersion: nextVersion,
        configJson: toSave as unknown as typeof toSave,
        // Phase 2 / P2-T2：8 权重权威列（与 configJson.weights 并行，双写保持兼容）。
        weightsJson: toSave.weights ?? null,
        active: true,
        orgId,
        updatedBy,
        ...(decisionJson ? { decisionJson } : {}),
      });

      this.invalidateActiveRowCache(orgId);
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
  async listVersions(orgId?: string | null): Promise<SchedulingPolicyVersionSummary[]> {
    // ADR-073：policy versions 读面 org 条件（org 匹配或 NULL 存量）。
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingPolicy)
          .where(
            or(isNull(ewohSchedulingPolicy.orgId), eq(ewohSchedulingPolicy.orgId, orgId)),
          )
          .orderBy(desc(ewohSchedulingPolicy.configVersion))
      : await this.db
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
    // NEST-165：版本号按 org 作用域递增（见 computeNextVersion 注释）。
    const nextVersion = await this.computeNextVersion(orgId);
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
    reason?: string,
  ): Promise<SchedulingPolicyConfig> {
    // R2-SSV-01（2026-08-17）：版本查找带 org 条件（本 org + NULL 全局行）——
    // 版本号按 org 作用域递增后，仅凭 configVersion 会命中他租户行。
    const row = await this.findByVersion(configVersion, orgId);
    if (!row) {
      throw new NotFoundException(
        `Scheduling policy version ${configVersion} not found`,
      );
    }
    // 1) 解除当前生效版本（NEST-104：org 作用域，绝不归档他租户 active 行）。
    await this.db
      .update(ewohSchedulingPolicy)
      .set({ active: false })
      .where(
        and(
          eq(ewohSchedulingPolicy.active, true),
          this.orgScopeCondition(orgId),
        ),
      );
    // 2) 激活目标版本（NO-13o / ADR-064：激活决策与 active 翻转同一
    // UPDATE 原子写 decisionJson；缺口显式留 NULL 不阻断主流程）。
    // R2-SSV-01：UPDATE 叠加 org 可见性条件（本 org + NULL 全局行），且
    // **绝不改写命中行的 orgId**（此前 set({orgId}) 会把他租户/全局行归属
    // 改写为当前租户——租户归属不可经激活漂移）。
    const decisionJson = this.projectPolicyActivationDecision(
      configVersion, orgId, updatedBy, reason,
    );
    const targetScope = orgId
      ? or(
          eq(ewohSchedulingPolicy.orgId, orgId),
          isNull(ewohSchedulingPolicy.orgId),
        )
      : isNull(ewohSchedulingPolicy.orgId);
    await this.db
      .update(ewohSchedulingPolicy)
      .set({
        active: true,
        updatedBy,
        updatedAt: new Date(),
        ...(decisionJson ? { decisionJson } : {}),
      })
      .where(
        and(
          eq(ewohSchedulingPolicy.configVersion, configVersion),
          targetScope,
        ),
      );
    this.invalidateActiveRowCache(orgId);
    this.logger.log(`activated scheduling policy v${configVersion} by ${updatedBy}`);
    const config = this.parseConfig(row.configJson);
    return { ...config, configVersion };
  }

  /**
   * NO-13o / ADR-064：policy_activation 决策投影（契约门内）。
   * 缺口/契约失败 → log 显式 + 返回 null（decision_json 不写，留 NULL），
   * 绝不阻断激活主流程（§2/§33）。
   */
  private projectPolicyActivationDecision(
    configVersion: number,
    orgId: string | null,
    approver: string,
    reason?: string,
  ): DecisionRecord | null {
    const { record, issues } = projectPolicyActivationDecision({
      configVersion,
      orgId,
      approver,
      reason,
      now: new Date(),
    });
    if (!record) {
      this.logger.warn(
        `policy activation 决策投影缺口 v${configVersion}（不阻断激活主流程）：${issues.join(',')}`,
      );
      return null;
    }
    return record;
  }

  /**
   * org 作用域条件（NEST-104）：orgId 非空 → 本 org 行；orgId 为空 → NULL
   * 全局行（系统路径只管理全局策略，不误伤租户行）。
   */
  private orgScopeCondition(orgId: string | null | undefined) {
    return orgId
      ? eq(ewohSchedulingPolicy.orgId, orgId)
      : isNull(ewohSchedulingPolicy.orgId);
  }

  /** org 可见性条件（NEST-105）：本 org 行 + NULL 存量全局行（与 RLS 等价）。 */
  private orgVisibilityCondition(orgId: string | null | undefined) {
    return orgId
      ? or(isNull(ewohSchedulingPolicy.orgId), eq(ewohSchedulingPolicy.orgId, orgId))
      : undefined;
  }

  /** 查询当前生效行（active=true 最新一条）。NEST-105：orgId 过滤。带 30s 内存缓存。 */
  private async findActiveRow(orgId?: string | null) {
    const cacheKey = orgId ?? '__global__';
    const now = Date.now();
    const cached = this.activeRowCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.row;
    }
    // NEST-105：无 orgId 时保持原查询形状 eq(active)（不过度包装 and()，
    // 兼容按形状解析 SQL 的测试替身）；有 orgId 时叠加 org 可见性条件。
    const orgCond = this.orgVisibilityCondition(orgId);
    const rows = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(
        orgCond
          ? and(eq(ewohSchedulingPolicy.active, true), orgCond)
          : eq(ewohSchedulingPolicy.active, true),
      )
      .orderBy(desc(ewohSchedulingPolicy.configVersion))
      .limit(1);
    const row = rows[0] ?? null;
    this.activeRowCache.set(cacheKey, {
      row,
      expiresAt: now + SchedulingPolicyService.CACHE_TTL_MS,
    });
    return row;
  }

  /**
   * 主动失效 active policy 缓存（策略写入/激活时调用）。
   * T8（2026-08-28）：改为 public——PolicyActivationService（activate/rollback）
   * 与 ShadowPolicyService（setStatus）等跨服务写入方也会修改 ewohSchedulingPolicy，
   * 写后必须失效本缓存，否则其它请求最长 30s（CACHE_TTL_MS）读到旧 active 行。
   * 同类内的 save/activate 路径维持原调用。
   */
  public invalidateActiveRowCache(orgId?: string | null): void {
    // 失效指定 org + 全局（NULL）两条缓存
    if (orgId) this.activeRowCache.delete(orgId);
    this.activeRowCache.delete('__global__');
  }

  /**
   * 查询指定 configVersion 的行。R2-SSV-01（2026-08-17）：orgId 提供时叠加
   * org 可见性条件（本 org + NULL 全局行）——configVersion 按 org 作用域递增
   * 后不同租户可存在同版本号行，仅凭版本号会命中他租户行；orgId 缺省 =
   * 系统后台流（GUC/RLS 兜底），保持原查询形状（测试替身兼容）。
   */
  private async findByVersion(configVersion: number, orgId?: string | null) {
    const orgCond = this.orgVisibilityCondition(orgId);
    const baseQuery = this.db.select().from(ewohSchedulingPolicy);
    const rows = await (orgCond
      ? baseQuery.where(
          and(eq(ewohSchedulingPolicy.configVersion, configVersion), orgCond),
        )
      : baseQuery.where(eq(ewohSchedulingPolicy.configVersion, configVersion))
    ).limit(1);
    return rows[0] ?? null;
  }

  /**
   * 计算下一个 configVersion（当前最大值 + 1，无数据则从 1 开始）。
   * NEST-165 修复（2026-08-17）：max 按 org 作用域取（orgId 非空 → 本 org +
   * NULL 全局行；orgId 空 → NULL 全局行）——否则两租户并发注册会取到同一
   * 全局 max+1 造成版本碰撞。uq (org, active) 部分唯一约束的最终落库兜底。
   */
  private async computeNextVersion(orgId?: string | null): Promise<number> {
    // NEST-165：无 orgId 时不附加 where（保持无过滤原形状，测试替身兼容）。
    const orgCond = this.orgVisibilityCondition(orgId);
    const baseQuery = this.db
      .select({ configVersion: ewohSchedulingPolicy.configVersion })
      .from(ewohSchedulingPolicy);
    const rows = await (orgCond ? baseQuery.where(orgCond) : baseQuery)
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
      // Phase 1 / P1-C（§六）：版本化目标 Profile 透传（缺失/非法回退内置预设，resolveProfiles 兜底）。
      profiles: (c.profiles ?? undefined) as SchedulingPolicyConfig['profiles'],
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
        // 封闭词表：'off' | 'advisory'（词表外一律回退缺省 off，不静默发明新模式）。
        durationModelMode:
          c.prediction?.durationModelMode === 'advisory'
            ? 'advisory'
            : DEFAULT_CONFIG.prediction.durationModelMode,
      },
      // --- CP-SAT 激活阶梯（Task A / P0）：cpSat 块透传，缺省=OFF（仅 heuristic） ---
      cpSat: {
        activation: this.activationState(
          c.cpSat?.activation,
          DEFAULT_CONFIG.cpSat!.activation,
        ),
        canaryFraction: this.num(c.cpSat?.canaryFraction, DEFAULT_CONFIG.cpSat!.canaryFraction),
        orgAllowlist: Array.isArray(c.cpSat?.orgAllowlist)
          ? c.cpSat!.orgAllowlist!.filter((o): o is string => typeof o === 'string')
          : DEFAULT_CONFIG.cpSat!.orgAllowlist,
        shadowCompare:
          c.cpSat?.shadowCompare === undefined
            ? DEFAULT_CONFIG.cpSat!.shadowCompare
            : Boolean(c.cpSat.shadowCompare),
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

  /** 解析 CP-SAT 激活状态（非法值回退缺省，绝不透传未知字符串）。 */
  private activationState(
    v: unknown,
    fallback: import('@shared/api.interface').SolverActivationState,
  ): import('@shared/api.interface').SolverActivationState {
    // NEST-120 修复（2026-08-17）：补全契约枚举——SolverActivationState 含
    // RULE_BASED/MILP（shared/scheduler.ts:1346），白名单漏掉会使合法持久化值
    // 被误回退缺省（契约漂移）。
    if (
      v === 'OFF' ||
      v === 'SHADOW' ||
      v === 'CANARY' ||
      v === 'PRODUCTION' ||
      v === 'RULE_BASED' ||
      v === 'MILP'
    ) {
      return v;
    }
    return fallback;
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