/**
 * 轻量埋点（PRD 对象工作台 §8 指标体系）。
 *
 * 设计取舍（依赖克制）：不引入任何分析 SDK，仅提供
 *   - 内存环形缓冲（供单测断言与本地排查）；
 *   - 可插拔 sink（后续接真实分析平台时 addTelemetrySink 即可，无需改调用点）。
 *
 * 覆盖 PRD 的驱动指标：
 *   - `object_workbench_view`   → 对象工作台曝光（工作台使用率）
 *   - `approval_deeplink_click` → 审批深链点击率（目标 ≥ 30%）
 *   - `terminal_action_click`   → 终态出口点击率（目标 ≥ 25%）
 *   - `nav_source`              → 侧边栏导航占比（目标下降 ≥ 30%）
 *
 * ⚠️ 当前全部指标**无历史基线**：仓库此前没有页面跳转与任务完成埋点，
 * 基线须在本功能上线后采集（PRD Q-6）。
 */

export type TelemetryEventName =
  | 'object_workbench_view'
  | 'approval_deeplink_click'
  | 'terminal_action_click'
  | 'nav_source';

export interface TelemetryEvent {
  name: TelemetryEventName;
  /** 事件时间戳（ms）；由调用方注入以便确定性断言。 */
  at: number;
  props: Record<string, string | number>;
}

export type TelemetrySink = (event: TelemetryEvent) => void;

/** 环形缓冲上限：仅保留最近事件，避免长时间运行后内存增长。 */
const BUFFER_LIMIT = 200;

const buffer: TelemetryEvent[] = [];
const sinks: TelemetrySink[] = [];

/** 注册 sink，返回注销函数。 */
export function addTelemetrySink(sink: TelemetrySink): () => void {
  sinks.push(sink);
  return () => {
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

/** 清空缓冲与全部 sink（测试用）。 */
export function resetTelemetry(): void {
  buffer.length = 0;
  sinks.length = 0;
}

/** 读取缓冲副本（测试断言 / 本地排查）。 */
export function getTelemetryEvents(): TelemetryEvent[] {
  return buffer.slice();
}

/**
 * 安装批量上报 sink（J2 Gate G-1：把埋点落到可查询处）。
 *
 * 设计取舍（KISS）：不做离线队列、不做重试、不引入 SDK。
 * 埋点是观测手段而非业务数据——**丢几条可以接受，影响业务不行**，
 * 因此失败一律静默吞掉，只保留 `window.__EWOH_TELEMETRY_FLUSH__` 供手动排查。
 *
 * 触发条件：累积 `batchSize` 条，或每 `intervalMs` 毫秒（取先到者）。
 *
 * @returns 卸载函数（停止定时器并尽力上报剩余事件）
 */
export function installBatchedTelemetrySink(
  ingest: (events: TelemetryEvent[]) => Promise<unknown>,
  options: { batchSize?: number; intervalMs?: number } = {},
): () => void {
  const batchSize = options.batchSize ?? 20;
  const intervalMs = options.intervalMs ?? 30_000;
  let pending: TelemetryEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const flush = (): void => {
    if (disposed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    // 上报失败静默：埋点不阻断业务，也不产生用户可见错误。
    void Promise.resolve(ingest(batch)).catch(() => undefined);
  };

  const dispose = addTelemetrySink((event) => {
    pending.push(event);
    if (pending.length >= batchSize) flush();
  });

  timer = setInterval(flush, intervalMs);

  return () => {
    // 顺序重要：先冲刷剩余事件（此时 disposed 仍为 false，flush 才会真正执行），
    // 再标记 disposed 并清理定时器。若先置 disposed，flush 会被自身守卫短路，
    // 导致卸载时丢失剩余事件。
    flush();
    disposed = true;
    if (timer != null) clearInterval(timer);
    dispose();
  };
}

/**
 * 记录一次事件。
 *
 * 埋点失败绝不能影响业务路径：任何 sink 抛错都在此吞掉。
 */
export function track(
  name: TelemetryEventName,
  props: Record<string, string | number> = {},
  at: number = Date.now(),
): TelemetryEvent {
  const event: TelemetryEvent = { name, at, props };
  buffer.push(event);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();
  for (const sink of sinks.slice()) {
    try {
      sink(event);
    } catch {
      // 埋点不可阻断业务。
    }
  }
  return event;
}

/**
 * ⚠️ 已移除 `postTelemetryEvents` / `ensureHttpTelemetrySink`（2026-09-01 勘误）：
 *
 * 此前 A1 实现在 index.tsx 用裸 fetch 直连 /api/telemetry/batch——**不带
 * Authorization header**，被全局 AccessTokenGuard 401 拒绝且静默吞掉，
 * 埋点从未落库。同时 app.tsx:67 已有既有接线
 * （`installBatchedTelemetrySink(ingestTelemetry)`，走 axiosForBackend 带 token），
 * 双 sink 并存属于重复上报。
 *
 * 现已统一：**HTTP 上报唯一入口是 `api/telemetry.ts` 的 `ingestTelemetry`**，
 * 由 app.tsx 的 RoutesComponent 挂载。本文件只保留内存缓冲与 sink 机制。
 */
