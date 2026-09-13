/**
 * Task 5 / P1：全局 Data Freshness Model（纯函数，node 可测）。
 *
 * 为 Command Map 各「事实源」（调度方案 / 世界·设备 / 调度上下文等）统一分类：
 * LIVE / DELAYED / STALE / OFFLINE / REPLAY / SHADOW / RESYNCING / DEGRADED。
 *
 * 分类规则（阈值显式化；Task 9/10 将 SchedulerRealtime V2 连接态
 * CONNECTED/DEGRADED/RESYNCING/OFFLINE 并入本词汇表，全局唯一状态词汇）：
 * - REPLAY    ：回放进行中（replayActive=true，优先级最高，任何连接态都覆盖）；
 * - SHADOW    ：方案/上下文为 shadow-only（shadowMode=true）；
 * - OFFLINE   ：SSE/连接断开（connected===false 或 connectionState==='OFFLINE'）。
 *               关键规则：SSE 断开但存在缓存数据时，状态**绝不**为 LIVE——
 *               断开判定优先于滞后计算（否则缓存时间戳仍很新会误报 LIVE）；
 * - RESYNCING ：连接态重同步中（connectionState==='RESYNCING'，增量被放弃、
 *               正在全量权威重建，缓存未经验证不得宣称 LIVE）；
 * - DEGRADED  ：连接降级（connectionState==='DEGRADED'，SSE 断开后轮询兜底，
 *               实时性降低）；
 * - 其余按滞后时间（lagMs，缺省由 now - lastUpdatedAt 计算）分类：
 *   - lag <= FRESHNESS_LIVE_LAG_MS（5s）      → LIVE；
 *   - lag <= FRESHNESS_STALE_LAG_MS（30s）    → DELAYED；
 *   - lag >  30s                               → STALE；
 *   - 无时间戳且无显式 lag（无新鲜度证据）      → STALE（保守，绝不无证据宣称 LIVE）。
 */

export type FreshnessStatus =
  | 'LIVE'
  | 'DELAYED'
  | 'STALE'
  | 'OFFLINE'
  | 'REPLAY'
  | 'SHADOW'
  | 'RESYNCING'
  | 'DEGRADED';

/** LIVE 阈值：数据滞后 <= 5s 视为实时。 */
export const FRESHNESS_LIVE_LAG_MS = 5_000;
/** DELAYED 阈值：数据滞后 <= 30s 视为延迟（可接受），超过视为 STALE。 */
export const FRESHNESS_STALE_LAG_MS = 30_000;

export interface FreshnessInput {
  /** 数据最近更新时间（epoch ms；无则 null）。 */
  lastUpdatedAt: number | null;
  /** 当前时间（epoch ms；可注入便于测试，缺省 Date.now()）。 */
  now?: number;
  /** 显式滞后（ms）；缺省由 now - lastUpdatedAt 计算。 */
  lagMs?: number;
  /** 连接状态（如 SchedulerStreamStatusV2 的字符串值；'OFFLINE' 视为断开）。 */
  connectionState?: string | null;
  /** 连接布尔（false 视为断开；缺省 undefined=不参与判定）。 */
  connected?: boolean;
  /** 回放激活（REPLAY 优先）。 */
  replayActive?: boolean;
  /** Shadow-only 方案/上下文（SHADOW 优先于滞后判定）。 */
  shadowMode?: boolean;
}

export const FRESHNESS_STATUS_LABELS: Record<FreshnessStatus, string> = {
  LIVE: '实时',
  DELAYED: '延迟',
  STALE: '过期',
  OFFLINE: '离线',
  REPLAY: '回放',
  SHADOW: 'Shadow',
  RESYNCING: '重同步',
  DEGRADED: '降级',
};

/**
 * 新鲜度状态展示优先级（越大越优先；REPLAY 恒为最高）。
 * 用于同屏多源/多信号叠加时的取大展示（如冲突徽标与新鲜度徽标并存）。
 */
export const FRESHNESS_STATUS_PRIORITY: Record<FreshnessStatus, number> = {
  REPLAY: 8,
  OFFLINE: 7,
  RESYNCING: 6,
  DEGRADED: 5,
  SHADOW: 4,
  STALE: 3,
  DELAYED: 2,
  LIVE: 1,
};

/** 纯函数：输入 → 新鲜度状态（规则见文件头注释）。 */
export function classifyFreshness(input: FreshnessInput): FreshnessStatus {
  if (input.replayActive) return 'REPLAY';
  if (input.shadowMode) return 'SHADOW';
  // 断开判定优先于滞后计算：SSE 断开 + 存在缓存 → OFFLINE（绝不 LIVE）。
  if (input.connected === false || input.connectionState === 'OFFLINE') return 'OFFLINE';
  // 连接态重同步/降级为一级状态（与 SchedulerRealtime V2 词汇统一）。
  if (input.connectionState === 'RESYNCING') return 'RESYNCING';
  if (input.connectionState === 'DEGRADED') return 'DEGRADED';

  let lag: number | null = input.lagMs ?? null;
  if (lag == null) {
    if (input.lastUpdatedAt != null && input.now != null) {
      lag = input.now - input.lastUpdatedAt;
    } else if (input.lastUpdatedAt != null) {
      lag = Date.now() - input.lastUpdatedAt;
    }
  }
  if (lag == null || !Number.isFinite(lag)) return 'STALE';
  // A future timestamp is invalid evidence, not zero lag. Keep it conservative.
  const timestamp = input.lastUpdatedAt;
  if (
    timestamp != null &&
    (!Number.isFinite(timestamp) ||
      (input.now != null ? timestamp > input.now : timestamp > Date.now()))
  ) {
    return 'STALE';
  }
  if (lag <= FRESHNESS_LIVE_LAG_MS) return 'LIVE';
  if (lag <= FRESHNESS_STALE_LAG_MS) return 'DELAYED';
  return 'STALE';
}

/** 纯函数：新鲜度判定的人读原因（tooltip 用）。 */
export function freshnessReason(input: FreshnessInput): string {
  if (input.replayActive) return '回放进行中，展示历史快照数据';
  if (input.shadowMode) return '当前为 Shadow-only 方案/上下文（非生产输出）';
  if (input.connected === false || input.connectionState === 'OFFLINE') {
    return input.connectionState === 'OFFLINE'
      ? 'SSE 连接断开（OFFLINE），缓存数据不得视为实时'
      : '连接已断开，缓存数据不得视为实时';
  }
  if (input.connectionState === 'RESYNCING') {
    return 'SSE 正在全量重同步（增量被放弃），以重同步源为准';
  }
  if (input.connectionState === 'DEGRADED') {
    return 'SSE 连接降级（轮询兜底），实时性降低';
  }
  const status = classifyFreshness(input);
  if (status === 'STALE' && input.lastUpdatedAt == null && input.lagMs == null) {
    return '无新鲜度证据（无时间戳），保守标记为过期';
  }
  let lag = input.lagMs ?? null;
  if (lag == null && input.lastUpdatedAt != null) {
    lag = (input.now ?? Date.now()) - input.lastUpdatedAt;
  }
  const lagText = lag != null && Number.isFinite(lag) ? `滞后 ${Math.max(0, Math.round(lag / 1000))}s` : null;
  switch (status) {
    case 'LIVE':
      return `数据实时${lagText ? `（${lagText} ≤ ${FRESHNESS_LIVE_LAG_MS / 1000}s）` : ''}`;
    case 'DELAYED':
      return `数据延迟${lagText ? `（${lagText} ≤ ${FRESHNESS_STALE_LAG_MS / 1000}s）` : ''}`;
    case 'STALE':
      return lagText ? `数据过期（${lagText} > ${FRESHNESS_STALE_LAG_MS / 1000}s）` : '数据过期';
    default:
      return status;
  }
}
