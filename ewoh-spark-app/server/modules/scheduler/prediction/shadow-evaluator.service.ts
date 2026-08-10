import { Injectable, Logger } from '@nestjs/common';
import type {
  PredictionConfig,
  PredictionShadowAggregate,
  PredictionShadowSample,
} from '@shared/api.interface';
import type { OrgContext } from '../../shared/org-context.interceptor';

/** 每 org 内存环形缓冲上限（无 migration；防无界增长）。 */
const MAX_SAMPLES_PER_ORG = 1000;

/**
 * Prediction Shadow Learning（Incremental Replan V2 / M05，08 §11）——shadow-only。
 *
 * 语义：
 *  - 记录预测样本（PredictionShadowSample）于内存环形缓冲（按 org）；
 *  - 待 ExecutionService / SchedulingFeedback 回填 actual 后计算 error 聚合
 *    （PredictionShadowAggregate：mae/rmse/p50/p95/calibration/fallbackRate/coverage）；
 *  - canary 阶梯仅控制 shadow 采样比例（生产预测输出仍为 deterministic baseline）；
 *    窗口聚合 error/fallback/coverage 超阈值 → 自动回退 canary 至 0%（SSE prediction.rollback）。
 *  - advisory-only：绝不写生产调度、不改变 dispatch、不替代 hard constraints。
 */
@Injectable()
export class ShadowEvaluatorService {
  private readonly logger = new Logger(ShadowEvaluatorService.name);
  /** org → 样本环形缓冲（FIFO）。 */
  private readonly samplesByOrg = new Map<string, PredictionShadowSample[]>();
  /** org → 当前 canary fraction（0..1；控制采样比例）。 */
  private readonly canaryByOrg = new Map<string, number>();

  /** 默认 canary 配置（缺省=现状：canary 0 不采样）。 */
  private readonly defaultConfig: Required<PredictionConfig> = {
    canaryFractions: [0, 0.05, 0.2, 0.5, 1],
    autoRollbackOn: {
      maxAbsoluteError: 0.25,
      maxFallbackRate: 0.5,
      minCoverage: 0.8,
    },
  };

  /** 记录一次 shadow 预测样本（预测 vs 确定性 baseline；actual 待回填）。
   *  支持可选 taskId 便于按任务维度回填（内部扩展字段，不进 PredictionShadowSample 契约）。 */
  recordSample(
    sample: Omit<PredictionShadowSample, 'actual' | 'absoluteError' | 'relativeError'> & {
      taskId?: string;
    },
    ctx?: OrgContext,
  ): void {
    const orgKey = (ctx?.primaryOrgId || 'ALL');
    const entry: PredictionShadowSample & { taskId?: string } = {
      ...sample,
      actual: null,
      absoluteError: null,
      relativeError: null,
    };
    if (sample.taskId) entry.taskId = sample.taskId;
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    buffer.push(entry);
    if (buffer.length > MAX_SAMPLES_PER_ORG) {
      buffer.splice(0, buffer.length - MAX_SAMPLES_PER_ORG);
    }
    this.samplesByOrg.set(orgKey, buffer);
  }

  /**
   * 回填 actual：按 (predictionType, createdAt) 匹配最近一条未回填样本并计算误差。
   * 由 SchedulingFeedback.recordActuals / ExecutionService 完成时调用。
   * 匹配不到时静默跳过（不伪造）。
   */
  backfillActual(
    predictionType: string,
    actual: number,
    createdAt: string,
    ctx?: OrgContext,
  ): boolean {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    // 匹配同 predictionType + createdAt 的最近样本（逆序找第一条未回填）。
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const s = buffer[i];
      if (s.predictionType === predictionType && s.createdAt === createdAt && s.actual == null) {
        s.actual = actual;
        s.absoluteError = Math.abs(s.prediction - actual);
        s.relativeError =
          actual !== 0 && Number.isFinite(actual)
            ? Math.abs(s.prediction - actual) / Math.abs(actual)
            : null;
        return true;
      }
    }
    this.logger.debug(
      `shadow backfill missed: ${predictionType}@${createdAt} (no open sample for ${orgKey})`,
    );
    return false;
  }

  /** 当前 canary fraction（org）。 */
  getCanaryFraction(ctx?: OrgContext): number {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    return this.canaryByOrg.get(orgKey) ?? 0;
  }

  /** 设置 canary fraction（0..1；仅控制采样比例）。 */
  setCanaryFraction(fraction: number, ctx?: OrgContext): void {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    this.canaryByOrg.set(orgKey, Math.min(1, Math.max(0, fraction)));
  }

  /** 是否应采样本预测（canary 阶梯决定；生产输出仍为 baseline）。 */
  shouldSample(seed: number, ctx?: OrgContext): boolean {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const fraction = this.canaryByOrg.get(orgKey) ?? 0;
    if (fraction <= 0) return false;
    if (fraction >= 1) return true;
    const h = (seed % 1000) / 1000;
    return h < fraction;
  }

  /** 按 org 聚合窗口指标（无样本/无 actual 时显式 0/null 语义）。 */
  aggregate(ctx?: OrgContext): PredictionShadowAggregate {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    const withActual = buffer.filter(
      (s) => s.actual != null && s.absoluteError != null && Number.isFinite(s.absoluteError),
    );
    const errors = withActual.map((s) => s.absoluteError as number).sort((a, b) => a - b);
    const n = errors.length;

    const mae = n > 0 ? errors.reduce((a, b) => a + b, 0) / n : 0;
    const rmse =
      n > 0 ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / n) : 0;
    const p50 = n > 0 ? this.percentile(errors, 0.5) : 0;
    const p95 = n > 0 ? this.percentile(errors, 0.95) : 0;

    // calibration：预测值相对 baseline 的偏离方向与误差的负相关（0..1 保守取 1−归一化 MAE）。
    const calibration =
      n > 0 ? Math.max(0, 1 - Math.min(mae, 1)) : 0;

    // fallbackRate：confidence < 阈值或 source=deterministic 的样本占比。
    const fallbackSamples = buffer.filter(
      (s) => s.confidence < 0.5 || s.modelVersion === 'deterministic-v1',
    );
    const fallbackRate =
      buffer.length > 0 ? fallbackSamples.length / buffer.length : 0;

    // coverage：有 actual 回填样本占比。
    const coverage = buffer.length > 0 ? withActual.length / buffer.length : 0;

    return { mae, rmse, p50, p95, calibration, fallbackRate, coverage };
  }

  /**
   * Canary 阶梯 + 自动回退（08 §11）：
   *  - 窗口聚合 error/fallback/coverage 超阈值 → canary 归 0，返回 rollback 事件。
   *  - advisory-only：仅改变采样比例，不改变生产求解输出。
   */
  evaluateCanary(config?: PredictionConfig, ctx?: OrgContext): {
    rolledBack: boolean;
    canaryFraction: number;
    aggregate: PredictionShadowAggregate;
    reasons: string[];
  } {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const cfg = {
      canaryFractions:
        config?.canaryFractions ?? this.defaultConfig.canaryFractions,
      autoRollbackOn: {
        ...this.defaultConfig.autoRollbackOn,
        ...(config?.autoRollbackOn ?? {}),
      },
    };
    const agg = this.aggregate(ctx);
    const reasons: string[] = [];
    if (agg.mae > cfg.autoRollbackOn.maxAbsoluteError) {
      reasons.push(`mae_exceeded:${agg.mae.toFixed(4)}`);
    }
    if (agg.fallbackRate > cfg.autoRollbackOn.maxFallbackRate) {
      reasons.push(`fallback_exceeded:${agg.fallbackRate.toFixed(4)}`);
    }
    if (agg.coverage < cfg.autoRollbackOn.minCoverage) {
      reasons.push(`coverage_low:${agg.coverage.toFixed(4)}`);
    }
    const rolledBack = reasons.length > 0;
    if (rolledBack) {
      this.canaryByOrg.set(orgKey, 0);
      this.logger.warn(
        `prediction canary rolled back for ${orgKey}: ${reasons.join('; ')}`,
      );
    }
    return {
      rolledBack,
      canaryFraction: this.canaryByOrg.get(orgKey) ?? 0,
      aggregate: agg,
      reasons,
    };
  }

  /** 测试/审计：读取 org 样本。 */
  listSamples(ctx?: OrgContext): Array<PredictionShadowSample & { taskId?: string }> {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    return [...(this.samplesByOrg.get(orgKey) ?? [])];
  }

  /** 测试用：清空。 */
  reset(ctx?: OrgContext): void {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    this.samplesByOrg.delete(orgKey);
    this.canaryByOrg.delete(orgKey);
  }

  private percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(Math.ceil(sortedAsc.length * p) - 1, sortedAsc.length - 1);
    return sortedAsc[Math.max(0, idx)];
  }
}
