import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc } from 'drizzle-orm';
import { ewohSchedulingPolicy } from '@server/database/schema';
import type {
  SchedulingPolicy,
  SchedulingPolicyConfig,
  SchedulingPolicyVersionSummary,
} from '@shared/api.interface';

/** 求解器版本：同一策略版本 + 求解器版本可确定性重放。 */
const DEFAULT_SOLVER_VERSION = 'heuristic-v2';

/** 无生效策略时的硬编码默认策略（消除 magic numbers 的兜底）。 */
const DEFAULT_POLICY: SchedulingPolicy = {
  version: 1,
  solverVersion: DEFAULT_SOLVER_VERSION,
  latenessWeight: 3,
  walkingWeight: 1,
  workloadBalanceWeight: 1,
  stationWaitWeight: 1,
  changeCostWeight: 0.5,
  riskWeight: 1,
  energyWeight: 0.5,
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
    return this.buildPolicy(config, row.configVersion);
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
    return this.buildPolicy(config, row.configVersion);
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

  /** 解析 jsonb 为 SchedulingPolicyConfig。 */
  private parseConfig(configJson: unknown): SchedulingPolicyConfig {
    return configJson as SchedulingPolicyConfig;
  }

  /**
   * 基于配置构建 SchedulingPolicy：目标权重取自配置（归一化、互不相同），
   * version 与配置版本绑定，solverVersion 固定。
   */
  private buildPolicy(
    config: SchedulingPolicyConfig,
    version: number,
  ): SchedulingPolicy {
    return {
      version,
      solverVersion: DEFAULT_SOLVER_VERSION,
      latenessWeight: config.priority.deadlineRiskWeight * 3,
      walkingWeight: config.euclideanDistanceWeight,
      workloadBalanceWeight: 1,
      stationWaitWeight: 1,
      changeCostWeight: 0.5,
      riskWeight: config.highRiskFactor / 2,
      energyWeight: config.minBatteryPct / 30,
    };
  }
}