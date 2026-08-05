/**
 * Wave W8「可观测性」— 前端指标采集（Web Vitals / 路由加载 / API 失败率 /
 * 离线同步延迟 / 冲突率 / 白屏 / 未处理异常）。
 *
 * 设计约定：
 * - 运行时零依赖：Web Vitals 仅用浏览器原生 PerformanceObserver 实现
 *   （`web-vitals` 未安装，见 package.json），无新依赖。
 * - 有界内存缓冲：`recordMetric` 只追加到有界数组，上限 MAX_BUFFER_SIZE 条。
 * - 不丢失冲刷：`flush()` POST 到后端摄取端点（默认已配置），发送成功前不清空
 *   本地缓冲；失败按指数退避 + 抖动重试，重试超限转入离线暂存（重连后重放），
 *   绝不默认静默丢弃。页面隐藏时优先用 sendBeacon 投递。
 * - 关联与脱敏：信封携带 requestId/traceId/组织页面/构建版本/设备类别；
 *   敏感源头在后端摄取时统一脱敏。
 * - 纯函数与统计计数器均可单测；浏览器专属的 Web Vitals 采集用守卫保护。
 */

import { logger } from './logger';
import { APP_VERSION } from './appContext';
import { getTraceContext as readRequestTrace } from './requestCorrelation';

export interface MetricRecord {
  name: string;
  value: number;
  tags?: Record<string, string | number | boolean>;
  /** 采集时刻（epoch ms）。 */
  at: number;
}

export const MAX_BUFFER_SIZE = 200;

/**
 * 前端指标摄取端点。后端暴露 `POST /api/observability/frontend-metrics`
 * （见 server/modules/observability/frontend-metrics.controller.ts），已接入
 * 生产链路；flush() 会批量 POST 这些指标，不再默认丢弃。
 */
export const FRONTEND_METRICS_ENDPOINT = '/api/observability/frontend-metrics';

/** 离线暂存 key（发送失败/离线时暂存，重连后重放，绝不静默丢弃）。 */
export const STAGE_STORAGE_KEY = 'ewoh.frontend-metrics.stage';
/** 离线暂存上限（条数），超出丢弃最旧。 */
export const STAGE_MAX = 2000;

/** 发送给后端的一个批次信封，携带关联与元数据。 */
export interface FrontendMetricsEnvelope {
  metrics: MetricRecord[];
  requestId?: string;
  traceId?: string;
  page?: string;
  buildVersion?: string;
  deviceCategory?: string;
}

export interface FlushOptions {
  /** 采样率 0..1；1 发送全部，<1 随机抽样。 */
  samplingRate?: number;
  /** 失败最大重试次数（超出后转入离线暂存）。 */
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 是否对退避时间加抖动，避免惊群。 */
  jitter?: boolean;
  /** 速率限制：每个 rateLimitWindowMs 窗口内最多触发 maxFlushesPerWindow 次发送。 */
  maxFlushesPerWindow?: number;
  /** 速率限制窗口（ms）。 */
  rateLimitWindowMs?: number;
}

const DEFAULT_FLUSH_OPTIONS: FlushOptions = {
  samplingRate: 1.0,
  maxRetries: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  jitter: true,
  maxFlushesPerWindow: 60,
  rateLimitWindowMs: 60_000,
};

const buffer: MetricRecord[] = [];

let retryCount = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let flushOptions: FlushOptions = { ...DEFAULT_FLUSH_OPTIONS };

/** 诊断用：允许测试注入传输层，避免真实网络。 */
export type FlushTransport = (envelope: FrontendMetricsEnvelope) => Promise<void>;
let flushTransport: FlushTransport | null = null;

/** 仅供测试注入传输层；传 null 恢复默认（动态 import http）。 */
export function setFlushTransportForTesting(transport: FlushTransport | null): void {
  flushTransport = transport;
}

/** 配置冲刷（采样/退避）。 */
export function configureFlush(options: FlushOptions): void {
  flushOptions = { ...flushOptions, ...options };
}

export function getFlushOptions(): FlushOptions {
  return { ...flushOptions };
}

function isSampled(): boolean {
  const rate = flushOptions.samplingRate ?? DEFAULT_FLUSH_OPTIONS.samplingRate!;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function computeBackoffMs(attempt: number): number {
  const base = flushOptions.backoffBaseMs ?? DEFAULT_FLUSH_OPTIONS.backoffBaseMs!;
  const max = flushOptions.backoffMaxMs ?? DEFAULT_FLUSH_OPTIONS.backoffMaxMs!;
  const jitter = flushOptions.jitter ?? true;
  const exp = Math.min(base * 2 ** attempt, max);
  if (!jitter) return exp;
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

/** 估算设备类别（低端/桌面/平板/手机/工业平板）。 */
export function detectDeviceCategory(ua: string = globalThis.navigator?.userAgent ?? ''): string {
  const lower = ua.toLowerCase();
  const isTablet = /ipad|tablet|playbook|silk/i.test(lower);
  const isMobile =
    /android.+mobile|iphone|ipod|windows phone|blackberry|iemobile/i.test(lower);
  if (isTablet) return 'tablet';
  if (isMobile) return 'mobile';
  if (/low.?mem|mobilecpu|mobile phone/i.test(lower)) return 'low-end';
  return 'desktop';
}

function currentPage(): string | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.location.pathname + window.location.search;
  } catch {
    return undefined;
  }
}

function buildEnvelope(metrics: MetricRecord[]): FrontendMetricsEnvelope {
  const envelope: FrontendMetricsEnvelope = {
    metrics,
    requestId: getTraceContext().requestId,
    traceId: getTraceContext().traceId,
    page: currentPage(),
    buildVersion: APP_VERSION,
    deviceCategory: detectDeviceCategory(),
  };
  return envelope;
}

// requestId/traceId 解析 —— 复用 requestCorrelation 的最新上下文。
function getTraceContext(): { requestId?: string; traceId?: string } {
  try {
    return readRequestTrace();
  } catch {
    return {};
  }
}

// ---- 离线暂存（失败/离线时保留证据，重连后重放） ----
interface StageEntry {
  envelope: FrontendMetricsEnvelope;
  at: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

/** 暂存存储（默认浏览器 localStorage；测试可注入内存实现）。 */
let stageStorage: StorageLike = globalThis.localStorage;

/** 仅供测试注入暂存存储。 */
export function setStageStorageForTesting(storage: StorageLike): void {
  stageStorage = storage;
}

function readStageEntries(): StageEntry[] {
  try {
    const raw = stageStorage?.getItem(STAGE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StageEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStageEntries(entries: StageEntry[]): void {
  try {
    stageStorage?.setItem(STAGE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage 不可用（容量/隐私模式）时静默放弃暂存，但不影响内存缓冲。
  }
}

function stageForReplay(metrics: MetricRecord[]): void {
  const entries = readStageEntries();
  entries.push({ envelope: buildEnvelope(metrics), at: Date.now() });
  while (entries.length > Math.floor(STAGE_MAX / 200)) {
    entries.shift();
  }
  writeStageEntries(entries);
}

/** 返回待重放的暂存信封数（供测试/诊断）。 */
export function getStagedCount(): number {
  return readStageEntries().length;
}

/** 清理暂存（发送成功/登出后调用）。 */
export function clearStaged(): void {
  try {
    stageStorage?.removeItem(STAGE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---- 丢弃统计 ----
/** 因队列上限 / 采样 / 速率限制而丢弃的指标条数（可查询，用于本地诊断）。 */
export interface DropStats {
  queueOverflowDropped: number;
  samplingDropped: number;
  rateLimitedDropped: number;
}

let dropStats: DropStats = {
  queueOverflowDropped: 0,
  samplingDropped: 0,
  rateLimitedDropped: 0,
};

/** 返回丢弃统计的只读快照。 */
export function getDropStats(): DropStats {
  return { ...dropStats };
}

/** 重置丢弃统计与限速窗口（测试 / 登出 / 诊断时调用）。 */
export function resetDropStats(): void {
  dropStats = { queueOverflowDropped: 0, samplingDropped: 0, rateLimitedDropped: 0 };
  flushTimestamps.length = 0;
}

// ---- 速率限制（单位时间最多发送 N 次） ----
/** 近一个窗口内已发生的发送时刻（epoch ms），用于滑动窗口限速。 */
const flushTimestamps: number[] = [];

function pruneFlushWindow(now: number): void {
  const windowMs = flushOptions.rateLimitWindowMs ?? DEFAULT_FLUSH_OPTIONS.rateLimitWindowMs!;
  while (flushTimestamps.length > 0 && now - flushTimestamps[0] > windowMs) {
    flushTimestamps.shift();
  }
}

/** 当前是否已超过限速窗口内的发送次数上限。 */
function isRateLimited(): boolean {
  const max = flushOptions.maxFlushesPerWindow ?? DEFAULT_FLUSH_OPTIONS.maxFlushesPerWindow!;
  pruneFlushWindow(Date.now());
  return flushTimestamps.length >= max;
}

/** 记录一次实际发送发生的时刻。 */
function recordSendTime(): void {
  pruneFlushWindow(Date.now());
  flushTimestamps.push(Date.now());
}

/** 记录一条指标到有界缓冲。 */
export function recordMetric(
  name: string,
  value: number,
  tags?: Record<string, string | number | boolean>,
): void {
  buffer.push({ name, value, tags, at: Date.now() });
  if (buffer.length > MAX_BUFFER_SIZE) {
    const dropped = buffer.length - MAX_BUFFER_SIZE;
    buffer.splice(0, dropped);
    dropStats.queueOverflowDropped += dropped;
  }
}

/** 只读视图（供测试/调试）。 */
export function getBuffer(): ReadonlyArray<MetricRecord> {
  return buffer;
}

export function getBufferSize(): number {
  return buffer.length;
}

export function clearBuffer(): void {
  buffer.length = 0;
}

/**
 * 安全冲刷：POST 缓冲指标到摄取端点。核心不变量：**发送成功前绝不清空本地缓冲**。
 * - 成功 → 清空缓冲并清除退避状态，返回本次条数。
 * - 失败 → 保留缓冲，指数退避 + 抖动安排重试；重试超限后转入离线暂存（重连后重放）。
 * - 采样丢弃是刻意行为（非静默 skip），仅当采样率 < 1 时发生。
 * - 绝不抛错。
 */
export async function flush(): Promise<number> {
  const payload = buffer.slice();
  if (payload.length === 0) return 0;
  if (!FRONTEND_METRICS_ENDPOINT) {
    // 无摄取端点：保留缓冲（不静默丢弃），等待配置后重试。
    scheduleRetry();
    return 0;
  }
  if (!isSampled()) {
    // 采样丢弃为刻意降采样，允许清空这批。
    dropStats.samplingDropped += payload.length;
    clearBuffer();
    return payload.length;
  }
  if (isRateLimited()) {
    // 速率限制为刻意节流（单位时间最多发送 N 次），超出窗口的批次被丢弃并计数。
    dropStats.rateLimitedDropped += payload.length;
    clearBuffer();
    return payload.length;
  }
  const envelope = buildEnvelope(payload);
  try {
    if (flushTransport) {
      await flushTransport(envelope);
    } else {
      // 惰性加载 http.ts：它的 import.meta.env 是 Vite 专属语法（jest CommonJS 无法
      // 静态解析），因此仅在确实需要发送时才动态加载，避免拖垮单测环境。
      const { axiosForBackend } = await import('./http');
      await axiosForBackend({
        url: FRONTEND_METRICS_ENDPOINT,
        method: 'POST',
        data: envelope,
      });
    }
    // 发送成功后才允许清空本地缓冲。
    recordSendTime();
    clearBuffer();
    retryCount = 0;
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    return payload.length;
  } catch (error) {
    logger.warn('[observability] flush failed, retaining buffer for retry', error);
    retryCount += 1;
    if (retryCount > (flushOptions.maxRetries ?? DEFAULT_FLUSH_OPTIONS.maxRetries!)) {
      // 重试耗尽：转入离线暂存，重连后重放，绝不静默丢弃。
      stageForReplay(payload);
      retryCount = 0;
      return 0;
    }
    scheduleRetry();
    return 0;
  }
}

/** 安排一次基于指数退避 + 抖动的延迟重试。 */
function scheduleRetry(): void {
  if (backoffTimer) return;
  const delayMs = computeBackoffMs(retryCount);
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void flush();
  }, delayMs);
}

/** 取消未决的退避定时器（测试/登出时调用）。 */
export function cancelPendingFlush(): void {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

/**
 * 在页面不可见/即将卸载时用 sendBeacon 尽量投递待发送指标（不阻塞页面卸载）。
 * 仅浏览器环境安装；返回卸载器。
 */
export function installPagehideFlush(): () => void {
  if (typeof document === 'undefined') return () => {};
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      void safeBeaconFlush();
    }
  };
  const onPagehide = (): void => {
    void safeBeaconFlush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPagehide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPagehide);
  };
}

/** 用 sendBeacon 尽量投递当前缓冲；失败或不可用时回退到常规 flush。 */
async function safeBeaconFlush(): Promise<void> {
  const payload = buffer.slice();
  if (payload.length === 0) return;
  const envelope = buildEnvelope(payload);
  try {
    const raw = JSON.stringify(envelope);
    const sent = typeof navigator !== 'undefined' && navigator.sendBeacon
      && navigator.sendBeacon(FRONTEND_METRICS_ENDPOINT, new Blob([raw], { type: 'text/plain' }));
    if (sent) {
      clearBuffer();
      return;
    }
  } catch {
    // 回退到常规 flush。
  }
  await flush();
}

// ---- API 失败率 ----
let apiTotal = 0;
let apiFailed = 0;

export function recordApiResult(success: boolean): void {
  apiTotal += 1;
  if (!success) {
    apiFailed += 1;
    recordMetric('api.failure', 1);
  } else {
    recordMetric('api.success', 1);
  }
}

export function getApiFailureRate(): number {
  return apiTotal === 0 ? 0 : apiFailed / apiTotal;
}

export function resetApiStats(): void {
  apiTotal = 0;
  apiFailed = 0;
}

// ---- 离线同步延迟 / 冲突率 ----
let syncTotal = 0;
let syncConflict = 0;

export function recordSyncLatency(durationMs: number): void {
  recordMetric('sync.queue.latency.ms', durationMs);
}

export function recordSyncOutcome(outcome: 'ok' | 'conflict'): void {
  syncTotal += 1;
  if (outcome === 'conflict') {
    syncConflict += 1;
    recordMetric('sync.conflict', 1);
  }
}

export function getConflictRate(): number {
  return syncTotal === 0 ? 0 : syncConflict / syncTotal;
}

export function resetSyncStats(): void {
  syncTotal = 0;
  syncConflict = 0;
}

// ---- 路由加载耗时 ----
export function recordRouteLoad(route: string, durationMs: number): void {
  recordMetric('route.load.ms', durationMs, { route });
}

// ---- 未处理异常 ----
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function captureUnhandledError(error: unknown, source?: string): void {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  recordMetric('unhandled.error', 1, {
    source: source ?? 'window',
    message: truncate(message, 200),
  });
}

// ---- 白屏检测 ----
export interface DocumentLike {
  body?: {
    childElementCount?: number;
    textContent?: string | null;
  };
}

/** 纯启发式：body 无子元素且无可见文本即判定为白屏。 */
export function isWhiteScreen(doc: DocumentLike | null | undefined): boolean {
  if (!doc?.body) return true;
  const childCount = doc.body.childElementCount ?? 0;
  const text = (doc.body.textContent ?? '').trim();
  return childCount === 0 && text.length === 0;
}

/** 检测白屏并打点，返回是否白屏。 */
export function detectWhiteScreen(doc?: DocumentLike): boolean {
  const white = isWhiteScreen(doc);
  if (white) {
    recordMetric('white.screen', 1);
  }
  return white;
}

// ---- Web Vitals（浏览器专属） ----
/**
 * 安装基于 PerformanceObserver 的最小 Web Vitals 采集器（LCP / CLS / FID）。
 * 返回卸载函数；非浏览器环境直接返回空操作。
 */
export function startWebVitalsCollection(): () => void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return () => {};
  }
  const observers: PerformanceObserver[] = [];

  try {
    const lcp = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry & { startTime?: number };
      if (last && typeof last.startTime === 'number') {
        recordMetric('webvital.lcp.ms', last.startTime);
      }
    });
    lcp.observe({ type: 'largest-contentful-paint', buffered: true });
    observers.push(lcp);
  } catch {
    // 浏览器不支持该条目类型时忽略。
  }

  try {
    let cls = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!e.hadRecentInput && typeof e.value === 'number') {
          cls += e.value;
        }
      }
      recordMetric('webvital.cls', cls);
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
    observers.push(clsObserver);
  } catch {
    // ignore
  }

  try {
    const fid = new PerformanceObserver((list) => {
      const first = list.getEntries()[0] as PerformanceEntry & {
        processingStart?: number;
        startTime?: number;
      };
      if (
        first &&
        typeof first.processingStart === 'number' &&
        typeof first.startTime === 'number'
      ) {
        recordMetric('webvital.fid.ms', first.processingStart - first.startTime);
      }
    });
    fid.observe({ type: 'first-input', buffered: true });
    observers.push(fid);
  } catch {
    // ignore
  }

  return () => {
    for (const observer of observers) {
      observer.disconnect();
    }
  };
}