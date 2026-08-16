/* empirical-duration-model.ts — 经验时长统计模型（NO-13g / ADR-056，§10 Level 2）。
 *
 * 真实统计模型（非参数经验分布，stdlib 纯函数，无外部依赖）：
 *  - train：来自真实执行反馈的时长样本 → median / p90（最近秩百分位）/
 *    count / spread（p90−median，离散度）；
 *  - predict：value = median；confidence 由样本量与离散度推导（真实不确定性，
 *    非伪造）；样本不足（< MIN_SAMPLES）→ 显式 not_enough_data（OOD 语义，
 *    调用方回退确定性基线并显式标注，§33 绝不把 unknown 当 normal）；
 *  - 确定性重放：同一样本集 → 同一模型（可审计/可复现，§9）。
 */

export const DURATION_MODEL_MIN_SAMPLES = 5;
export const EMPIRICAL_MODEL_KIND = 'task-duration-empirical';
export const EMPIRICAL_SOURCE = 'ml';

export interface DurationModel {
  /** 中位时长（ms）。 */
  medianMs: number;
  /** p90 时长（ms，最近秩百分位）。 */
  p90Ms: number;
  /** 样本数。 */
  count: number;
  /** 离散度（p90 − median，ms）。 */
  spreadMs: number;
}

export interface DurationTrainingResult {
  model: DurationModel | null;
  /** null 时必填（显式缺口，§33）。 */
  notEnoughDataReason?: string;
}

function nearestRankPercentile(sorted: number[], percentile: number): number {
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil((percentile / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** 训练：真实时长样本 → 模型；空/非有限/样本不足 → null + 显式理由。 */
export function trainDurationModel(samples: number[]): DurationTrainingResult {
  if (!Array.isArray(samples)) {
    return { model: null, notEnoughDataReason: 'invalid_samples' };
  }
  const clean = samples.filter((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0);
  if (clean.length === 0) {
    return { model: null, notEnoughDataReason: 'no_finite_samples' };
  }
  if (clean.length < DURATION_MODEL_MIN_SAMPLES) {
    return { model: null, notEnoughDataReason: `not_enough_data:${clean.length}` };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const medianMs = nearestRankPercentile(sorted, 50);
  const p90Ms = nearestRankPercentile(sorted, 90);
  return {
    model: { medianMs, p90Ms, count: clean.length, spreadMs: Math.max(0, p90Ms - medianMs) },
  };
}

/** 置信度：样本量 + 离散度推导的真实不确定性（0..1 裁剪）。 */
export function durationConfidence(model: DurationModel): number {
  const countFactor = Math.min(0.6, model.count / 100);
  const spreadRatio = model.medianMs > 0 ? model.spreadMs / model.medianMs : 1;
  const spreadPenalty = Math.min(0.4, spreadRatio * 0.4);
  return Math.max(0.1, Math.min(0.95, 0.35 + countFactor - spreadPenalty));
}

/** 模型版本串（版本号由注册表递增管理，训练侧拼接）。 */
export function durationModelVersion(registryVersion: number): string {
  return `empirical-v${registryVersion}`;
}

/** NO-13u / ADR-070：模型 id 词表（org 命名空间 + per-taskType 分组）。 */
export function orgModelId(orgId: string): string {
  return `${EMPIRICAL_MODEL_KIND}:${orgId}`;
}

export function orgTaskTypeModelId(orgId: string, taskType: string): string {
  return `${EMPIRICAL_MODEL_KIND}:${orgId}:${taskType}`;
}

/** 是否经验时长模型（历史全局/org 命名空间/分组）——注册表前缀过滤（hydrate 全量回填）。 */
export function isEmpiricalModelId(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string' || modelId === '') return false;
  return modelId === EMPIRICAL_MODEL_KIND || modelId.startsWith(`${EMPIRICAL_MODEL_KIND}:`);
}

/** NO-13u / ADR-070：模型 id → orgId（org 命名空间段；历史全局模型返回 null——显式弃用）。 */
export function orgIdFromModelId(modelId: string | null | undefined): string | null {
  if (typeof modelId !== 'string') return null;
  if (modelId === EMPIRICAL_MODEL_KIND) return null;
  const prefix = `${EMPIRICAL_MODEL_KIND}:`;
  if (!modelId.startsWith(prefix)) return null;
  const rest = modelId.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  return firstColon === -1 ? rest : rest.slice(0, firstColon);
}
