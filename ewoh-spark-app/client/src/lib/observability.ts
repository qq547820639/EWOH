/**
 * Wave W8「可观测性」— 前端指标采集（Web Vitals / 路由加载 / API 失败率 /
 * 离线同步延迟 / 冲突率 / 白屏 / 未处理异常）。
 *
 * 设计约定：
 * - 运行时零依赖：Web Vitals 仅用浏览器原生 PerformanceObserver 实现
 *   （`web-vitals` 未安装，见 package.json），无新依赖。
 * - 有界内存缓冲：`recordMetric` 只追加到有界数组，上限 MAX_BUFFER 条。
 * - 安全 flush：仅当配置了摄取端点（FRONTEND_METRICS_ENDPOINT）时才 POST；
 *   当前后端未暴露 `/api/observability/frontend-metrics`，缺省为空串，
 *   flush 退化为"清空缓冲 + 日志"，绝不抛错、绝不产生网络噪声。
 * - 纯函数与统计计数器均可单测；浏览器专属的 Web Vitals 采集用守卫保护。
 */

import { logger } from './logger';

export interface MetricRecord {
  name: string;
  value: number;
  tags?: Record<string, string | number | boolean>;
  /** 采集时刻（epoch ms）。 */
  at: number;
}

export const MAX_BUFFER_SIZE = 200;

/**
 * 前端指标摄取端点。默认空串表示后端尚无对应接口；如需启用，改此值并确保
 * 后端暴露 `POST /api/observability/frontend-metrics`。
 */
export const FRONTEND_METRICS_ENDPOINT = '';

const buffer: MetricRecord[] = [];

/** 记录一条指标到有界缓冲。 */
export function recordMetric(
  name: string,
  value: number,
  tags?: Record<string, string | number | boolean>,
): void {
  buffer.push({ name, value, tags, at: Date.now() });
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
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
 * 安全冲刷：抽空缓冲并 POST 到摄取端点（若已配置）。
 * 无论是否配置端点、无论网络是否失败，都会清空缓冲并返回本次条数，绝不抛错。
 */
export async function flush(): Promise<number> {
  const payload = buffer.splice(0, buffer.length);
  if (payload.length === 0) return 0;
  if (!FRONTEND_METRICS_ENDPOINT) {
    logger.info(
      `[observability] buffered ${payload.length} metric(s) dropped — no ingest endpoint configured`,
    );
    return payload.length;
  }
  try {
    // 惰性加载 http.ts：它的 import.meta.env 是 Vite 专属语法（jest CommonJS 无法
    // 静态解析），因此仅在确实配置了摄取端点时才动态加载，避免拖垮单测环境。
    const { axiosForBackend } = await import('./http');
    await axiosForBackend({
      url: FRONTEND_METRICS_ENDPOINT,
      method: 'POST',
      data: { metrics: payload },
    });
  } catch (error) {
    logger.warn('[observability] flush failed', error);
  }
  return payload.length;
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