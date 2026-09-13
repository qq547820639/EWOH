/* Phase 3 / P3-T2 前端：SSE 实时数据源纯函数核心。
 *
 * 从 useSchedulerStream 抽出的纯决策函数（node 环境可测，无 DOM 依赖）：
 * - sequence 单调守卫：sse / resync / poll 三源之间防止回退；
 * - 缺口检测：跳号 → 无法安全增量续接 → 需要全量 resync；
 * - 轮询兜底决策：SSE 连续错误达到阈值 → 切换轮询。
 * React Hook（useSchedulerStream / useCommandMapSchedulerState）组合这些纯函数。
 */

import { queryKeys } from '@client/src/hooks/queryKeys';

export type RealtimeSource = 'sse' | 'resync' | 'poll';

/** 对外暴露的实时连接健康状态（V2 枚举，供 Provider / UI 徽标消费）。 */
export type SchedulerStreamStatusV2 = 'CONNECTED' | 'DEGRADED' | 'RESYNCING' | 'OFFLINE';

/** 内部状态 → V2 枚举的纯映射（node 可测）。 */
export function mapToV2Status(params: {
  status: 'idle' | 'connecting' | 'live' | 'polling' | 'error';
  resyncing: boolean;
}): SchedulerStreamStatusV2 {
  // 活动重同步优先暴露 RESYNCING（增量被放弃，正在全量权威重建）。
  if (params.resyncing) return 'RESYNCING';
  switch (params.status) {
    case 'live':
      return 'CONNECTED';
    case 'polling':
      return 'DEGRADED';
    case 'idle':
    case 'connecting':
      return 'CONNECTED';
    case 'error':
      return 'OFFLINE';
  }
}

/**
 * 轮询兜底期间需刷新的决策关键读模型（Task 2.3/2.4）。
 * 与 `triggerResync` 保持一致：仅刷新活跃方案会导致快照/资源/冲突/路由
 * 在 SSE 断开期间停留陈旧状态，地图叠加层与冲突中心会展示过时数据。
 * 返回的 key 数组与 useCommandMapSchedulerState 等消费方使用的 queryKey 一致。
 */
export function pollingInvalidateKeys(): Array<readonly unknown[]> {
  return [
    queryKeys.schedulerActivePlans,
    queryKeys.schedulerSnapshot,
    queryKeys.schedulerResourceState,
    queryKeys.schedulerConflicts(),
    ['scheduler-routes'],
  ];
}

export interface SequenceDecision {
  /** 是否接受该 sequence（false = 回退/重复，直接丢弃）。 */
  accept: boolean;
  /** 是否检测到缺口（需全量 resync）。 */
  gap: boolean;
  /** 更新后的 lastSequence。 */
  lastSequence: number;
}

/**
 * 单调 sequence 守卫 + 缺口检测（三源防回退）。
 * - seq <= last → 重复/回退，丢弃；
 * - seq === last + 1 → 正常增量；
 * - seq > last + 1 → 缺口（跳号），需要全量 resync；
 * - last === 0（首次/基线）→ 接受任意 seq（新基线）。
 */
export function nextSequence(prev: number, seq: number): SequenceDecision {
  if (!Number.isFinite(seq) || seq < 0) {
    return { accept: false, gap: false, lastSequence: prev };
  }
  if (seq <= prev) {
    return { accept: false, gap: false, lastSequence: prev };
  }
  const gap = prev > 0 && seq > prev + 1;
  return { accept: true, gap, lastSequence: seq };
}

/**
 * resync 事件/全量重建后重置续传游标（以服务器权威 currentSequence 为新基线）。
 * 返回新的 lastSequence；缺口内事件由全量重拉恢复，不猜测。
 */
export function resyncBaseline(prev: number, currentSequence: number): number {
  return Number.isFinite(currentSequence) && currentSequence >= 0
    ? currentSequence
    : prev;
}

/**
 * SSE 断开后的降级决策：
 * - 连续错误达到 maxConsecutiveErrors → 切换到轮询兜底（polling=true）；
 * - 未达到阈值 → 保持 error 状态等待重连；
 * - 任一轮询期间都继续按 reconnectInterval 尝试重连 SSE，成功后切回实时。
 */
export function nextStreamState(params: {
  consecutiveErrors: number;
  maxConsecutiveErrors: number;
  currentlyPolling: boolean;
}): { status: 'polling' | 'error'; shouldStartPolling: boolean } {
  const reached =
    params.consecutiveErrors >= params.maxConsecutiveErrors ||
    params.currentlyPolling;
  if (reached) {
    return { status: 'polling', shouldStartPolling: !params.currentlyPolling };
  }
  return { status: 'error', shouldStartPolling: false };
}

/**
 * 三源单调防回退合并器：给定上一来源的 lastSequence 与本次观察到的 sequence，
 * 返回是否可安全应用到 store（sse 增量 / resync 全量 / poll 全量）。
 * - resync / poll 为全量源：以其 currentSequence 为新基线（允许大于或等于，不允许回退）；
 * - sse 为增量源：必须严格 +1 或落入 gap→resync。
 */
export function mergeSourceSequence(
  source: RealtimeSource,
  prev: number,
  observed: number,
): SequenceDecision {
  if (source === 'resync' || source === 'poll') {
    if (observed <= prev) {
      // 全量源不得让游标回退（服务器重启降序属异常，保守丢弃）。
      return { accept: false, gap: false, lastSequence: prev };
    }
    return { accept: true, gap: false, lastSequence: observed };
  }
  return nextSequence(prev, observed);
}

/* ------------------------------------------------------------------ *
 * Task 11 / 11.1：SSE 高频事件批处理/合并（big-data 体验）。
 *
 * - `coalesceEvents`：纯函数——同一事件类型（如 device.telemetry）在一个批次窗口内
 *   只保留最新 keepPerType 条；结构性业务事件（plan.* / conflict.* / replan.* /
 *   assignment.* / run.* / execution.*）原样保序保留，保证每事件语义不变。
 *   输出按 sequence 升序（保序应用，供单调守卫消费）。
 * - `createEventBatcher`：纯逻辑批处理器（时钟/调度器可注入，node 可测）——
 *   收集窗口内（默认 80ms，可配置）的同批事件，flush 时一次性合并后回调；
 *   结构性事件即时 flush（不等窗口），保持业务事件的近实时性；
 *   批次大小达到 maxBatchSize 立即 flush，防止无限堆积。
 * ------------------------------------------------------------------ */

/** 结构性业务事件前缀：这些事件必须逐条、按序、即时应用（不进入合并窗口）。 */
export const DEFAULT_STRUCTURAL_PREFIXES = [
  'plan.',
  'conflict.',
  'replan.',
  'assignment.',
  'run.',
  'execution.',
] as const;

/** 事件是否属于结构性业务事件（需即时/逐条应用）。 */
export function isStructuralEventType(
  type: string,
  prefixes: readonly string[] = DEFAULT_STRUCTURAL_PREFIXES,
): boolean {
  return prefixes.some((prefix) => type.startsWith(prefix));
}

/** 参与批处理/合并的最小事件形状（schedulerRealtimeCore 不依赖 shared 类型，便于 node 单测）。 */
export interface BatchableEvent {
  sequence: number;
  eventType?: string | null;
}

export interface CoalesceOptions {
  /** 结构性事件前缀（默认 DEFAULT_STRUCTURAL_PREFIXES）。 */
  structuralPrefixes?: readonly string[];
  /** 合并窗口内同一事件类型保留的条数（默认 1 = 仅保留最新）。 */
  keepPerType?: number;
}

/**
 * 合并一批事件：
 * - 结构性事件（plan./conflict./replan. 等）全部保序保留（业务语义逐条生效）；
 * - 其余高频事件（如 device.telemetry）同一类型在同一批次内只保留最新的
 *   keepPerType 条（后到者覆盖先到者——遥测只看最新值）；
 * - 输出按 sequence 升序稳定排序，保证单调守卫/业务应用顺序不被破坏。
 */
export function coalesceEvents<TEvent extends BatchableEvent>(
  events: readonly TEvent[],
  options: CoalesceOptions = {},
): TEvent[] {
  const structuralPrefixes = options.structuralPrefixes ?? DEFAULT_STRUCTURAL_PREFIXES;
  const keepPerType = Math.max(1, options.keepPerType ?? 1);

  const structural: TEvent[] = [];
  // 同一类型的分桶：仅保留最新 keepPerType 条（后到覆盖先到）。
  const buckets = new Map<string, TEvent[]>();
  const typeOrder: string[] = [];

  for (const event of events) {
    const type = event.eventType ?? '';
    if (isStructuralEventType(type, structuralPrefixes)) {
      structural.push(event);
      continue;
    }
    let bucket = buckets.get(type);
    if (!bucket) {
      bucket = [];
      buckets.set(type, bucket);
      typeOrder.push(type);
    }
    bucket.push(event);
    if (bucket.length > keepPerType) bucket.shift();
  }

  const coalesced = [...structural];
  for (const type of typeOrder) {
    coalesced.push(...(buckets.get(type) ?? []));
  }
  // 保序：批次内事件 sequence 单调（到达序 == 序号序），合并后仍按 sequence 升序稳定排列，
  // 保证消费方按序应用（缺口检测/业务顺序不受合并影响）。
  return coalesced.sort((a, b) => a.sequence - b.sequence);
}

/** 一次 flush 的批次负载：已合并事件 + 窗口内原始 seq 边界（缺口检测基准）。 */
export interface EventBatch<TEvent extends BatchableEvent> {
  /** 已合并（保序、按 sequence 升序）的事件。 */
  events: TEvent[];
  /** 批次窗口内**收到**的最小 sequence（与上游游标比较做缺口检测）。 */
  minSeq: number;
  /** 批次窗口内**收到**的最大 sequence（游标推进基准，合并丢弃中间 seq 不视为缺口）。 */
  maxSeq: number;
  /** 窗口内原始事件数（合并前后对比，衡量写放大削减）。 */
  rawCount: number;
}

export interface EventBatcher<TEvent extends BatchableEvent> {
  /** 推入一条事件；结构性事件触发立即 flush（含积压），其余进入合并窗口。 */
  push: (event: TEvent) => void;
  /** 立即合并并 flush 积压（返回本次是否有内容写出）。 */
  flush: () => boolean;
  /** 取消定时器并丢弃积压（卸载/重连前调用）。 */
  dispose: () => void;
  /** 当前积压条数。 */
  pendingCount: number;
}

export interface CreateEventBatcherParams<TEvent extends BatchableEvent> {
  /** 合并窗口（ms），默认 80。 */
  windowMs?: number;
  /** 单批最大事件数，超过立即 flush（防无限堆积），默认 64。 */
  maxBatchSize?: number;
  /** 结构性事件前缀（默认 DEFAULT_STRUCTURAL_PREFIXES）。 */
  structuralPrefixes?: readonly string[];
  /** 合并选项透传。 */
  coalesce?: CoalesceOptions;
  /** flush 回调（合并后逐批写出）。 */
  onFlush: (batch: EventBatch<TEvent>) => void;
  /** 注入时钟（默认 Date.now），便于单测。 */
  now?: () => number;
  /** 注入定时器（默认 setTimeout/clearTimeout），便于单测。 */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

/**
 * 创建事件批处理器：窗口内合并高频事件，结构性事件即时 flush。
 * 纯逻辑（无 React/DOM 依赖），时钟与调度器可注入——node 环境可测。
 */
export function createEventBatcher<TEvent extends BatchableEvent>(
  params: CreateEventBatcherParams<TEvent>,
): EventBatcher<TEvent> {
  const windowMs = Math.max(0, params.windowMs ?? 80);
  const maxBatchSize = Math.max(1, params.maxBatchSize ?? 64);
  const coalesceOptions: CoalesceOptions = {
    structuralPrefixes: params.structuralPrefixes ?? DEFAULT_STRUCTURAL_PREFIXES,
    ...params.coalesce,
  };

  let pending: TEvent[] = [];
  let timer: { cancel: () => void } | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer) {
      timer.cancel();
      timer = null;
    }
  };

  const flushNow = (): boolean => {
    cancelTimer();
    if (pending.length === 0) return false;
    const batch = pending;
    pending = [];
    const minSeq = batch[0].sequence;
    const maxSeq = batch[batch.length - 1].sequence;
    const rawCount = batch.length;
    const events = coalesceEvents(batch, coalesceOptions);
    params.onFlush({ events, minSeq, maxSeq, rawCount });
    return true;
  };

  const armTimer = () => {
    if (timer || disposed) return;
    timer = params.schedule ? params.schedule(flushNow, windowMs) : scheduleDefault(flushNow, windowMs);
  };

  return {
    push(event: TEvent) {
      if (disposed) return;
      const type = event.eventType ?? '';
      if (isStructuralEventType(type, coalesceOptions.structuralPrefixes ?? DEFAULT_STRUCTURAL_PREFIXES)) {
        // 结构性业务事件：先 flush 积压（保持相对顺序），再立即应用本条。
        flushNow();
        params.onFlush({
          events: [event],
          minSeq: event.sequence,
          maxSeq: event.sequence,
          rawCount: 1,
        });
        return;
      }
      pending.push(event);
      if (pending.length >= maxBatchSize) {
        flushNow();
        return;
      }
      armTimer();
    },
    flush: flushNow,
    dispose() {
      disposed = true;
      cancelTimer();
      pending = [];
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

function scheduleDefault(fn: () => void, ms: number): { cancel: () => void } {
  const id = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(id) };
}

/**
 * P1-D：STALE CONTEXT 判定（纯函数，node 可测）。
 *
 * 统一调度上下文（GET /api/scheduler/context）是 Command Map 的版本边界；
 * 任一活跃方案（含当前选中方案）的 snapshotVersion 与 context.snapshotVersion
 * 不一致 → true，UI 必须显式标记 `STALE CONTEXT`（禁止静默混合不同版本数据）。
 *
 * 判空策略（避免误报）：
 * - context 缺失（未拉到/加载中）→ false（无对照物，无从判定）；
 * - 方案未声明 snapshotVersion → 不参与比较（无法核验，不误报）。
 */
export function isContextStale(params: {
  context: { snapshotVersion?: string | null } | null;
  plans: Array<{ snapshotVersion?: string | null }> | null;
  activePlan?: { snapshotVersion?: string | null } | null;
}): boolean {
  const ctxVersion = params.context?.snapshotVersion;
  if (!ctxVersion) return false;
  const candidates: Array<string | null | undefined> = [];
  if (params.plans) candidates.push(...params.plans.map((p) => p.snapshotVersion));
  if (params.activePlan) candidates.push(params.activePlan.snapshotVersion);
  return candidates.some((v) => Boolean(v) && v !== ctxVersion);
}
