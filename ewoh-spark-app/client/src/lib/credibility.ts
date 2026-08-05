/**
 * UX-001 数据可信度 —— 纯函数格式化/判定模块。
 *
 * 将原始数据来源元信息（sourceType / collectedAt / lastSyncedAt / 离线缓存 /
 * 模拟回放 / 完整性 / 置信度）归一化为结构化的可信度摘要，并给出
 * 「是否可用于决策」的判定。供 DataCredibility 组件及各处视图复用。
 */

export interface CredibilityInfo {
  /** 数据来源类型（real / controlled_test / simulated / replayed / stale / offline 等）。 */
  sourceType?: string;
  /** 采集时间（ISO）。 */
  collectedAt?: string;
  /** 最近同步时间（ISO）。 */
  lastSyncedAt?: string;
  /** 数据完整性 0..1。 */
  completeness?: number;
  /** 置信度 0..1。 */
  confidence?: number;
  /** 是否来自离线缓存。 */
  isOfflineCache?: boolean;
  /** 是否模拟或回放数据。 */
  isSimulatedOrReplay?: boolean;
  /** 显式授权标记（false 则强制不可用于决策）。 */
  decisionAuthorized?: boolean;
}

export interface CredibilitySummary {
  sourceType?: string;
  collectedAt?: string;
  lastSyncedAt?: string;
  isStale: boolean;
  isOfflineCache: boolean;
  isSimulatedOrReplay: boolean;
  completeness?: number;
  confidence?: number;
  decisionEligible: boolean;
}

/** 默认过期阈值：5 分钟。 */
export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;
/** 默认决策置信度下限：80%。 */
export const MIN_DECISION_CONFIDENCE = 0.8;

/** 最近同步时间是否已超过阈值（视为过期）。无同步时间视为过期。 */
export function isStale(
  lastSyncedAt: string | undefined,
  now = Date.now(),
  thresholdMs = DEFAULT_STALE_THRESHOLD_MS,
): boolean {
  if (!lastSyncedAt) return true;
  const t = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > thresholdMs;
}

/**
 * 是否可用于决策：
 * 模拟/回放、离线缓存、显式未授权、过期、完整性不足、置信度不足 → 均不可用。
 */
export function isDecisionEligible(
  info: CredibilityInfo,
  now = Date.now(),
  thresholdMs = DEFAULT_STALE_THRESHOLD_MS,
): boolean {
  if (info.isSimulatedOrReplay) return false;
  if (info.isOfflineCache) return false;
  if (info.decisionAuthorized === false) return false;
  if (isStale(info.lastSyncedAt, now, thresholdMs)) return false;
  if (info.completeness !== undefined && info.completeness < 1) return false;
  if (info.confidence !== undefined && info.confidence < MIN_DECISION_CONFIDENCE) {
    return false;
  }
  return true;
}

/** 归一化可信度摘要。 */
export function credibilitySummary(
  info: CredibilityInfo,
  now = Date.now(),
  thresholdMs = DEFAULT_STALE_THRESHOLD_MS,
): CredibilitySummary {
  return {
    sourceType: info.sourceType,
    collectedAt: info.collectedAt,
    lastSyncedAt: info.lastSyncedAt,
    isStale: isStale(info.lastSyncedAt, now, thresholdMs),
    isOfflineCache: Boolean(info.isOfflineCache),
    isSimulatedOrReplay: Boolean(info.isSimulatedOrReplay),
    completeness: info.completeness,
    confidence: info.confidence,
    decisionEligible: isDecisionEligible(info, now, thresholdMs),
  };
}

/** 0..1 → 百分比字符串，非法值返回 '—'。 */
export function percent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** ISO 时间 → 中文本地时间字符串。 */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}