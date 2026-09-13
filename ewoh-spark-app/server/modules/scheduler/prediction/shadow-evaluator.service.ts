import { BadRequestException, Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, desc, gte, isNull, lt, type SQL } from 'drizzle-orm';
import { predictionShadowObservation } from '@server/database/schema';
import { currentRequestContext } from '../../../common/request-context';
import { DETERMINISTIC_MODEL_VERSION } from './prediction-provider';
import type {
  PredictionConfig,
  PredictionShadowAggregate,
  PredictionShadowSample,
} from '@shared/api.interface';
import type { OrgContext } from '../../shared/org-context.interceptor';

/** 每 org 内存环形缓冲上限（无 migration；防无界增长）。 */
const MAX_SAMPLES_PER_ORG = 1000;

/** 持久化保留默认时长（30 天；advisory-only 观测数据，超期由 pruneObservations 清理）。 */
const DEFAULT_OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 惰性 prune 最小间隔（1 小时一次；防高频 recordSample 反复扫表）。 */
const PRUNE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 内部扩展样本：PredictionShadowSample 契约 + 持久化辅助字段（不进公开契约）。
 * correlationId 为稳定回填键；executionId/policyVersion/snapshotVersion 仅溯源。
 */
type ShadowSampleEntry = PredictionShadowSample & {
  taskId?: string;
  entityId?: string;
  correlationId?: string;
  executionId?: string;
  policyVersion?: number;
  snapshotVersion?: string;
  /** 采样腿给出的"预计可回填时刻"（计划窗口 plannedEnd，ISO）。回填到期判据用；缺省回退 createdAt+baseline。 */
  expectedActualAt?: string;
};

/**
 * 回填"到期"宽限（2026-09-13，R-3 自查修正）：样本过了预计可回填时刻仍无 actual，
 * 才算"应回填而未回填"，才允许进入 coverage 回退判定。
 *
 * 为什么需要宽限：实际结束晚于计划结束是常态（执行延迟、回执落库延迟），把刚过
 * plannedEnd 的在途样本立刻计为缺失，会让 coverage 在真实执行中几乎恒低于
 * minCoverage——叠加"每条回执都 evaluateCanary 一次"的接线（scheduling-feedback），
 * 任何多任务方案的第一条回执都会把 canary 归零（实测复现：coverage_low:0.5000），
 * 阶梯永远无法放量——与本次已修的 mae 刻度问题同一类"可触发但不可用"。
 * 30min 吸收常规执行/回执延迟；真正断链的回填腿（样本过期数小时仍无 actual）依然会触发回退。
 */
const BACKFILL_DUE_GRACE_MS = 30 * 60 * 1000;

/**
 * R-3（2026-09-13）稳定关联键：采样腿（计划基线落库）与回填腿（recordActuals）必须用
 * **同一个函数**构造 correlationId。
 *
 * 为什么需要它：采样发生在 dispatch 之前、回填发生在任务真实执行之后，两侧唯一都持有的
 * 事实是 planId/assignmentId/taskId；任一侧手写字符串拼接（分隔符/空值处理不同）都会让回填
 * 静默失配——内存样本 actual 永久为 null、coverage 恒 0、canary 永不达标，学习腿重新断链。
 * 无 assignment/task 时返回 null：plan 级观测没有可精确匹配的键，调用方应显式不采样。
 */
export function shadowCorrelationId(
  planId: string,
  assignmentId?: string | null,
  taskId?: string | null,
): string | null {
  if (!planId?.trim() || (!assignmentId && !taskId)) return null;
  return `${planId}|${assignmentId ?? '-'}|${taskId ?? '-'}`;
}

/**
 * R-3 采样种子：correlationId → [0,1000) 的确定性整数（FNV-1a）。
 *
 * 为什么不用 Math.random()：shouldSample 按 canary 比例决定是否采样，同一次派工必须每次
 * 得到同一判定（重放/重试/测试可复现），否则同一方案在不同进程/重试下采样集合漂移，
 * 观测数据不可审计。
 */
export function stableSampleSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1000;
}

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
 *
 * R-3（2026-09-13）接线：采样腿 = SchedulingFeedbackService.recordBaseline（计划基线落库时
 * 按 canary 采样），回填腿 = SchedulingFeedbackService.recordActuals（真实回执落库成功后按
 * shadowCorrelationId 精确回填 + evaluateCanary）。canary 缺省 0 → 两侧都不动作，行为与接线前
 * 逐字节一致。
 */
@Injectable()
export class ShadowEvaluatorService {
  private readonly logger = new Logger(ShadowEvaluatorService.name);
  /** org → 样本环形缓冲（FIFO）。 */
  private readonly samplesByOrg = new Map<string, ShadowSampleEntry[]>();
  /** org → 当前 canary fraction（0..1；控制采样比例）。 */
  private readonly canaryByOrg = new Map<string, number>();
  /** 上次惰性 prune 时间戳（防高频 recordSample 反复扫表）。 */
  private lastPruneAtMs = 0;

  constructor(
    // Task 7：durable observation 持久化。db 可选——未注入 DB 时保持纯内存语义
    // （既有直构测试/纯内存部署不受影响）；持久化失败仅记日志，绝不阻断调度。
    @Inject(DRIZZLE_DATABASE) private readonly db?: PostgresJsDatabase,
  ) {}

  /** 默认 canary 配置（缺省=现状：canary 0 不采样）。 */
  private readonly defaultConfig: Required<PredictionConfig> = {
    canaryFractions: [0, 0.05, 0.2, 0.5, 1],
    autoRollbackOn: {
      maxAbsoluteError: 0.25,
      maxFallbackRate: 0.5,
      minCoverage: 0.8,
    },
    durationModelMode: 'off',
  };

  /** 记录一次 shadow 预测样本（预测 vs 确定性 baseline；actual 待回填）。
   *  支持可选 taskId/entityId/correlationId/executionId/policyVersion/snapshotVersion
   *  便于按任务/执行维度回填与溯源（内部扩展字段，不进 PredictionShadowSample 契约）。
   *  Task 7：内存环形缓冲保持为快速缓存；持久化 fire-and-forget（失败仅记日志）。 */
  recordSample(
    sample: Omit<PredictionShadowSample, 'actual' | 'absoluteError' | 'relativeError'> & {
      taskId?: string;
      entityId?: string;
      correlationId?: string;
      executionId?: string;
      policyVersion?: number;
      snapshotVersion?: string;
      expectedActualAt?: string;
    },
    ctx?: OrgContext,
  ): void {
    const orgKey = (ctx?.primaryOrgId || 'ALL');
    const entry: ShadowSampleEntry = {
      ...sample,
      actual: null,
      absoluteError: null,
      relativeError: null,
    };
    if (sample.taskId) entry.taskId = sample.taskId;
    if (sample.entityId) entry.entityId = sample.entityId;
    if (sample.correlationId) entry.correlationId = sample.correlationId;
    if (sample.executionId) entry.executionId = sample.executionId;
    if (sample.policyVersion != null) entry.policyVersion = sample.policyVersion;
    if (sample.snapshotVersion) entry.snapshotVersion = sample.snapshotVersion;
    if (sample.expectedActualAt) entry.expectedActualAt = sample.expectedActualAt;
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    buffer.push(entry);
    if (buffer.length > MAX_SAMPLES_PER_ORG) {
      buffer.splice(0, buffer.length - MAX_SAMPLES_PER_ORG);
    }
    this.samplesByOrg.set(orgKey, buffer);
    // Task 7：持久化（fire-and-forget；失败仅记日志，绝不抛出/阻断调用方）。
    this.persistSample(orgKey, entry);
    this.maybePrune();
  }

  /** 持久化一条 shadow 观察（fire-and-forget）。 */
  private persistSample(orgKey: string, entry: ShadowSampleEntry): void {
    if (!this.db) return;
    this.db
      .insert(predictionShadowObservation)
      .values({
        orgId: orgKey === 'ALL' ? null : orgKey,
        predictionType: entry.predictionType,
        entityId: entry.entityId ?? null,
        taskId: entry.taskId ?? null,
        correlationId: entry.correlationId ?? null,
        executionId: entry.executionId ?? null,
        prediction: entry.prediction,
        baseline: entry.baseline ?? null,
        actual: null,
        confidence: entry.confidence ?? null,
        modelVersion: entry.modelVersion ?? null,
        policyVersion: entry.policyVersion ?? null,
        snapshotVersion: entry.snapshotVersion ?? null,
        createdAt: new Date(entry.createdAt),
      })
      .then(() => undefined)
      .catch((err) => {
        this.logger.warn(
          `shadow observation persist skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** 持久化回填入口（fire-and-forget）。 */
  private persistBackfill(
    predictionType: string,
    actual: number,
    createdAt: string,
    orgKey: string,
    extra?: { taskId?: string; correlationId?: string },
  ): void {
    if (!this.db) return;
    void this.applyPersistedBackfill(predictionType, actual, createdAt, orgKey, extra).catch(
      (err) => {
        this.logger.warn(
          `shadow observation backfill skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  /**
   * 持久化行回填：匹配优先级 correlation_id → (task_id, prediction_type) →
   * (prediction_type, created_at)，均要求未回填（actual IS NULL）；DB 无匹配行时
   * 静默跳过（与内存语义一致）。误差从 DB 行的 prediction 计算（内存与 DB 独立存储）。
   */
  private async applyPersistedBackfill(
    predictionType: string,
    actual: number,
    createdAt: string,
    orgKey: string,
    extra?: { taskId?: string; correlationId?: string },
  ): Promise<void> {
    const orgCond =
      orgKey === 'ALL' ? undefined : eq(predictionShadowObservation.orgId, orgKey);
    const notBackfilled = isNull(predictionShadowObservation.actual);
    let condition: SQL | undefined;
    if (extra?.correlationId) {
      condition = and(
        eq(predictionShadowObservation.correlationId, extra.correlationId),
        notBackfilled,
        orgCond,
      );
    } else if (extra?.taskId) {
      condition = and(
        eq(predictionShadowObservation.taskId, extra.taskId),
        eq(predictionShadowObservation.predictionType, predictionType),
        notBackfilled,
        orgCond,
      );
    } else {
      condition = and(
        eq(predictionShadowObservation.predictionType, predictionType),
        eq(predictionShadowObservation.createdAt, new Date(createdAt)),
        notBackfilled,
        orgCond,
      );
    }
    const [row] = await this.db!
      .select()
      .from(predictionShadowObservation)
      .where(condition)
      .orderBy(desc(predictionShadowObservation.createdAt))
      .limit(1);
    if (!row) return; // DB 无匹配行 → 静默跳过。
    const absoluteError = Math.abs(row.prediction - actual);
    const relativeError =
      actual !== 0 && Number.isFinite(actual)
        ? Math.abs(row.prediction - actual) / Math.abs(actual)
        : null;
    await this.db!
      .update(predictionShadowObservation)
      .set({ actual, absoluteError, relativeError, actualAt: new Date() })
      .where(eq(predictionShadowObservation.id, row.id));
  }

  /**
   * 惰性保留清理：recordSample 每 1 小时至多触发一次（防高频采样反复扫表）；
   * 删除 created_at < now − retentionMs 的行。失败仅记日志，绝不影响采样。
   */
  private maybePrune(): void {
    if (!this.db) return;
    const now = Date.now();
    if (now - this.lastPruneAtMs < PRUNE_MIN_INTERVAL_MS) return;
    this.lastPruneAtMs = now;
    void this.pruneObservations(DEFAULT_OBSERVATION_RETENTION_MS).catch((err) => {
      this.logger.warn(
        `shadow observation prune skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * 回填 actual：按 (predictionType, createdAt) 匹配最近一条未回填样本并计算误差。
   * 由 SchedulingFeedback.recordActuals / ExecutionService 完成时调用。
   * 匹配不到时静默跳过（不伪造）。
   *
   * R-3（2026-09-13）：匹配优先级与持久化侧（applyPersistedBackfill）**逐条对齐**——
   * correlationId → (taskId, predictionType) → (predictionType, createdAt)。
   * 为什么必须对齐：采样侧写入 createdAt=`采样时刻`，回填侧拿到的是执行回执（actualStart/
   * actualEnd），**无法复现采样时刻**；此前内存侧只按 createdAt 严格比较，于是"接上采样腿"
   * 之后每条样本在内存里都回填不到（actual 恒 null → coverage 恒 0 → canary 永远不达标），
   * 只有 DB 行被更新，内存聚合与持久化聚合长期相互矛盾。
   *
   * Task 7：内存更新与持久化行更新并行——DB 无匹配行时静默跳过（与内存语义一致）。
   */
  backfillActual(
    predictionType: string,
    actual: number,
    createdAt: string,
    ctx?: OrgContext,
    extra?: { taskId?: string; correlationId?: string },
  ): boolean {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    // 逆序找第一条未回填且匹配的样本（同一键重复时取最近的一条）。
    const matches = (s: ShadowSampleEntry): boolean => {
      if (s.actual != null) return false;
      if (extra?.correlationId) return s.correlationId === extra.correlationId;
      if (extra?.taskId) return s.taskId === extra.taskId && s.predictionType === predictionType;
      return s.predictionType === predictionType && s.createdAt === createdAt;
    };
    let matched = false;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const s = buffer[i];
      if (!matches(s)) continue;
      s.actual = actual;
      s.absoluteError = Math.abs(s.prediction - actual);
      s.relativeError =
        actual !== 0 && Number.isFinite(actual)
          ? Math.abs(s.prediction - actual) / Math.abs(actual)
          : null;
      matched = true;
      break;
    }
    if (!matched) {
      this.logger.debug(
        `shadow backfill missed: ${predictionType}@${extra?.correlationId ?? createdAt} (no open sample for ${orgKey})`,
      );
    }
    // 持久化行回填（fire-and-forget；失败仅记日志，不改变返回值语义）。
    this.persistBackfill(predictionType, actual, createdAt, orgKey, extra);
    return matched;
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
    // NEST-045（2026-08-17）：引用 DETERMINISTIC_MODEL_VERSION 常量（与
    // prediction-provider 单一事实源，替代硬编码字符串漂移）。
    const fallbackSamples = buffer.filter(
      (s) => s.confidence < 0.5 || s.modelVersion === DETERMINISTIC_MODEL_VERSION,
    );
    const fallbackRate =
      buffer.length > 0 ? fallbackSamples.length / buffer.length : 0;

    // coverage：有 actual 回填样本占比。
    const coverage = buffer.length > 0 ? withActual.length / buffer.length : 0;

    return { mae, rmse, p50, p95, calibration, fallbackRate, coverage };
  }

  /**
   * Task 7：查询持久化观察（durable observation）。
   * 过滤：orgId / taskId / predictionType / since（含）/ until（不含）/ limit / offset；
   * 按 created_at 倒序。未注入 DB 时返回 []（纯内存部署无持久化视图）。
   * 说明：SQL 复杂过滤/窗口聚合是未来优化方向，当前保持简单全量过滤。
   */
  async listObservations(
    ctx: OrgContext | undefined,
    opts: {
      orgId?: string;
      taskId?: string;
      predictionType?: string;
      limit?: number;
      offset?: number;
      since?: string;
      until?: string;
    } = {},
  ): Promise<Array<typeof predictionShadowObservation.$inferSelect>> {
    if (!this.db) {
      this.logger.debug('listObservations: no db injected, returning []');
      return [];
    }
    // NEST-043 修复（2026-08-17）：HTTP 请求上下文内强制 org 作用域（本表为
    // GLOBAL_SHARED advisory 观测，null=全局采样是**系统**语义——HTTP 无 ctx
    // 的调用不再放行全租户观察；后台/分析流显式走 opts.orgId/系统路径）。
    const orgKey = ctx?.primaryOrgId || 'ALL';
    if (orgKey === 'ALL' && !opts.orgId && currentRequestContext()) {
      throw new BadRequestException(
        'org scope required for shadow observations（NEST-043）',
      );
    }
    const conditions: SQL[] = [];
    const orgFilter = opts.orgId ?? (orgKey === 'ALL' ? undefined : orgKey);
    if (orgFilter) conditions.push(eq(predictionShadowObservation.orgId, orgFilter));
    if (opts.taskId) conditions.push(eq(predictionShadowObservation.taskId, opts.taskId));
    if (opts.predictionType) {
      conditions.push(eq(predictionShadowObservation.predictionType, opts.predictionType));
    }
    if (opts.since) {
      conditions.push(gte(predictionShadowObservation.createdAt, new Date(opts.since)));
    }
    if (opts.until) {
      conditions.push(lt(predictionShadowObservation.createdAt, new Date(opts.until)));
    }
    return this.db
      .select()
      .from(predictionShadowObservation)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(predictionShadowObservation.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
  }

  /**
   * Task 7：从持久化观察计算窗口聚合（MAE/RMSE/p50/p95/calibration/fallbackRate/coverage），
   * 语义与内存 aggregate() 一致（同一 percentile/fallback/coverage 规则）。
   * 过滤：modelVersion / siteOrOrg / rollingWindowMs（created_at >= now − window）；
   * ctx 租户隔离优先（与内存 per-org 语义一致）。
   * 未注入 DB 时回退到内存 aggregate()（保持无 DB 部署行为不变）。
   * 说明：当前为「加载匹配行 → JS 计算」的简单实现；SQL/窗口聚合是未来优化方向。
   */
  async aggregatePersisted(
    ctx?: OrgContext,
    opts: { modelVersion?: string; siteOrOrg?: string; rollingWindowMs?: number } = {},
  ): Promise<PredictionShadowAggregate> {
    if (!this.db) return this.aggregate(ctx);
    const orgKey = ctx?.primaryOrgId || 'ALL';
    // R2-SSV-25（2026-08-17）：补 NEST-043 同款 HTTP 守卫——HTTP 上下文且
    // org=ALL 且未显式 opts.siteOrOrg 时 fail-closed（400），不再全表（全部
    // 租户）观察行进入 MAE/RMSE/coverage 聚合；系统后台流保持全量语义。
    if (orgKey === 'ALL' && !opts.siteOrOrg && currentRequestContext()) {
      throw new BadRequestException(
        'org scope required for shadow observation aggregation（R2-SSV-25）',
      );
    }
    const conditions: SQL[] = [];
    const orgFilter = opts.siteOrOrg ?? (orgKey === 'ALL' ? undefined : orgKey);
    if (orgFilter) conditions.push(eq(predictionShadowObservation.orgId, orgFilter));
    if (opts.modelVersion) {
      conditions.push(eq(predictionShadowObservation.modelVersion, opts.modelVersion));
    }
    if (opts.rollingWindowMs != null && opts.rollingWindowMs > 0) {
      conditions.push(
        gte(
          predictionShadowObservation.createdAt,
          new Date(Date.now() - opts.rollingWindowMs),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(predictionShadowObservation)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(predictionShadowObservation.createdAt));
    const withActual = rows.filter(
      (s) =>
        s.actual != null && s.absoluteError != null && Number.isFinite(s.absoluteError),
    );
    const errors = withActual
      .map((s) => s.absoluteError as number)
      .sort((a, b) => a - b);
    const n = errors.length;

    const mae = n > 0 ? errors.reduce((a, b) => a + b, 0) / n : 0;
    const rmse = n > 0 ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / n) : 0;
    const p50 = n > 0 ? this.percentile(errors, 0.5) : 0;
    const p95 = n > 0 ? this.percentile(errors, 0.95) : 0;
    const calibration = n > 0 ? Math.max(0, 1 - Math.min(mae, 1)) : 0;
    const fallbackSamples = rows.filter(
      // NEST-045：引用常量（同上）。
      (s) =>
        s.confidence == null ||
        s.confidence < 0.5 ||
        s.modelVersion === DETERMINISTIC_MODEL_VERSION,
    );
    const fallbackRate =
      rows.length > 0 ? fallbackSamples.length / rows.length : 0;
    const coverage = rows.length > 0 ? withActual.length / rows.length : 0;

    return { mae, rmse, p50, p95, calibration, fallbackRate, coverage };
  }

  /**
   * Task 7：保留清理——删除 created_at < now − olderThanMs 的持久化观察，
   * 返回删除行数。advisory-only：只清理观测数据，不影响任何生产表。
   *
   * NEST-044 修复（2026-08-17）：可选 orgId 作用域——提供时仅清理该 org 的
   * 观察行；缺省 = 全局保留清理（advisory 观测表的系统维护语义，
   * standalone_057 裁决 GLOBAL_SHARED），但 HTTP 请求上下文内必须显式传
   * orgId 或走系统任务（防止租户请求触发全租户清理）。
   */
  async pruneObservations(
    olderThanMs: number,
    orgId?: string | null,
  ): Promise<number> {
    if (!this.db) return 0;
    if (!orgId && currentRequestContext()) {
      throw new BadRequestException(
        'org scope required for observation prune in HTTP context（NEST-044；全局清理走系统任务）',
      );
    }
    const cutoff = new Date(Date.now() - olderThanMs);
    const deleted = await this.db
      .delete(predictionShadowObservation)
      .where(
        and(
          lt(predictionShadowObservation.createdAt, cutoff),
          orgId ? eq(predictionShadowObservation.orgId, orgId) : undefined,
        ),
      )
      .returning({ id: predictionShadowObservation.id });
    return Array.isArray(deleted) ? deleted.length : 0;
  }

  /**
   * Canary 阶梯 + 自动回退（08 §11）：
   *  - 窗口聚合 error/fallback/coverage 超阈值 → canary 归 0，返回 rollback 事件。
   *  - advisory-only：仅改变采样比例，不改变生产求解输出。
   *
   * 自查修正（2026-09-13）：**回退只能由"坏证据"触发，不能由"缺证据"触发**。
   *  - `error_undecidable`（没有可算相对误差的样本）与 `coverage_undecidable`
   *    （还没有任何到期待回填的样本）只进入 `reasons` 供观测，**不参与回退判定**
   *    ——此前 `reasons.length > 0` 一律回退，把"还没证据"当成"证据显示坏了"，
   *    与本函数"缺证据不判定"的注释直接矛盾（实测：唯一回填样本 actual=0 即把
   *    canary 归零）；
   *  - coverage 判定改为**到期感知**（见 BACKFILL_DUE_GRACE_MS）：只有过了预计
   *    可回填时刻仍无 actual 的样本才算"缺失"，在途样本不计入分母——否则多任务
   *    方案的第一条回执（coverage=1/N<0.8）必然误杀 canary（实测复现）。
   *  相对误差超限 / fallbackRate 超限 / 到期样本 coverage 不足这三条是**坏证据**，
   *  保持回退（护栏不放松）。
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
    /** 坏证据：任一非空即回退。 */
    const rollbackReasons: string[] = [];
    /** 缺证据观测：只上报，不判定（缺证据 ≠ 判负）。 */
    const observedReasons: string[] = [];
    // 误差判定的**刻度**（2026-09-13 修正）：
    // `autoRollbackOn` 的三个阈值（maxAbsoluteError 0.25 / maxFallbackRate 0.5 /
    // minCoverage 0.8）**都是 [0,1] 比率**——两个邻居显然是比率，`0.25` 也只在比率
    // 刻度上才有意义。但 `agg.mae` 是**毫秒绝对误差**（样本 prediction/baseline/actual
    // 一律 ms）。原先拿 ms 与 0.25 比，等于"误差超过 0.25 毫秒就回退"——实测
    // `mae_exceeded:600000` 即 10 分钟误差触发，于是**任何一次真实回填都会立刻把
    // canary 归零**，阶梯永远无法放量（"可触发"但不可用）。
    // 现在按**相对误差**判定（|预测−实际|/|实际|，与样本侧的 relativeError 同口径），
    // 绝对 mae 仍留在 reason 里供观测——两个刻度都可见，不隐藏任何一个。
    const relative = this.meanRelativeError(ctx);
    if (relative === null) {
      // 无法计算（没有带 actual 的样本，或 actual 全为 0）：**不判定**，
      // 而不是用"0 误差"假装通过，也不据此回退（缺证据 ≠ 达标，≠ 判负）。
      observedReasons.push('error_undecidable:no_relative_sample');
    } else if (relative > cfg.autoRollbackOn.maxAbsoluteError) {
      rollbackReasons.push(
        `relative_error_exceeded:${relative.toFixed(4)}`
          + `(阈值 ${cfg.autoRollbackOn.maxAbsoluteError}；绝对 mae=${agg.mae.toFixed(0)}ms)`,
      );
    }
    if (agg.fallbackRate > cfg.autoRollbackOn.maxFallbackRate) {
      rollbackReasons.push(`fallback_exceeded:${agg.fallbackRate.toFixed(4)}`);
    }
    const coverageDecision = this.dueAwareCoverage(ctx);
    if (coverageDecision.undecidable) {
      // 还没有任何"到期应回填"的样本：coverage 无证据可判（在途 ≠ 断链）。
      observedReasons.push('coverage_undecidable:no_due_sample');
    } else if (coverageDecision.coverage < cfg.autoRollbackOn.minCoverage) {
      rollbackReasons.push(
        `coverage_low:${coverageDecision.coverage.toFixed(4)}`
          + `(到期缺失 ${coverageDecision.dueOpen}/${coverageDecision.dueTotal})`,
      );
    }
    const rolledBack = rollbackReasons.length > 0;
    if (rolledBack) {
      this.canaryByOrg.set(orgKey, 0);
      this.logger.warn(
        `prediction canary rolled back for ${orgKey}: `
          + [...rollbackReasons, ...observedReasons].join('; '),
      );
    }
    return {
      rolledBack,
      canaryFraction: this.canaryByOrg.get(orgKey) ?? 0,
      aggregate: agg,
      // reasons = 坏证据 + 缺证据观测（顺序：先坏证据；调用方按前缀自行过滤）。
      reasons: [...rollbackReasons, ...observedReasons],
    };
  }

  /**
   * 到期感知的 coverage（仅回退判定用；`aggregate().coverage` 仍是无时间窗的
   * 诚实占比，口径不变）。"到期"= 过了预计可回填时刻（expectedActualAt，缺省
   * 回退 createdAt+baseline）再加宽限（BACKFILL_DUE_GRACE_MS）仍无 actual。
   * undecidable = 没有任何到期样本（全部在途或缓冲为空）——此时 coverage 无证据。
   */
  private dueAwareCoverage(ctx?: OrgContext): {
    undecidable: boolean;
    coverage: number;
    dueOpen: number;
    dueTotal: number;
  } {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    const nowMs = Date.now();
    let dueOpen = 0;
    let dueTotal = 0;
    for (const s of buffer) {
      const dueAtMs = this.sampleDueAtMs(s);
      if (dueAtMs == null || nowMs <= dueAtMs) continue; // 未到期在途：不算缺失证据
      dueTotal += 1;
      if (s.actual == null) dueOpen += 1;
    }
    if (dueTotal === 0) return { undecidable: true, coverage: 1, dueOpen: 0, dueTotal: 0 };
    return { undecidable: false, coverage: (dueTotal - dueOpen) / dueTotal, dueOpen, dueTotal };
  }

  /** 样本的"预计可回填时刻"（ms）。expectedActualAt 优先；缺省回退 createdAt+baseline；无法解析 → null（永不到期，缺字段不构成证据）。 */
  private sampleDueAtMs(s: ShadowSampleEntry): number | null {
    const fromExpected = s.expectedActualAt ? Date.parse(s.expectedActualAt) : NaN;
    const base = Number.isFinite(fromExpected)
      ? fromExpected
      : Date.parse(s.createdAt) + (typeof s.baseline === 'number' && Number.isFinite(s.baseline) && s.baseline > 0 ? s.baseline : 0);
    if (!Number.isFinite(base)) return null;
    return base + BACKFILL_DUE_GRACE_MS;
  }

  /**
   * 本 org 缓冲区内的**平均相对误差**（|预测−实际|/|实际|）。
   *
   * 为什么单独算而不复用 `aggregate().mae`：后者是**毫秒绝对误差**，与
   * `autoRollbackOn` 的比率阈值不同刻度（见 `evaluateCanary` 的说明）。
   * 返回 `null`（而不是 0）表示**无样本可判定**——缺证据必须显式表达，
   * 否则"没有数据"会被当成"零误差达标"。
   */
  private meanRelativeError(ctx?: OrgContext): number | null {
    const orgKey = ctx?.primaryOrgId || 'ALL';
    const buffer = this.samplesByOrg.get(orgKey) ?? [];
    const values = buffer
      .map((s) => s.relativeError)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /** 测试/审计：读取 org 样本。 */
  listSamples(ctx?: OrgContext): ShadowSampleEntry[] {
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
