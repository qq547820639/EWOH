import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getPlan } from '@client/src/api/scheduler';
import { getAccessToken } from '@client/src/lib/auth';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  mapToV2Status,
  pollingInvalidateKeys,
  createEventBatcher,
  type EventBatcher,
  type EventBatch,
  type SchedulerStreamStatusV2,
} from '@client/src/pages/CommandMap/hooks/schedulerRealtimeCore';
import type { SchedulingEvent, SchedulingPlanV2 } from '@shared/api.interface';

/**
 * 调度实时事件流 Hook（SSE）。
 *
 * 消费后端 `GET /api/scheduler/v2/stream`，将事件增量写入 React Query 缓存，
 * 并处理：sequence 去重、Last-Event-ID 续传、缺口检测→全量重同步（resync）、
 * SSE 失败→轮询兜底→恢复后回到 SSE。
 *
 * Task 11 / 11.1（big-data）：高频事件（如 device.telemetry）经 createEventBatcher
 * 在短窗口内（默认 80ms，可配置 batchWindowMs）合并后一次性写出，避免每个事件都
 * 触发一次 React 状态更新；结构性业务事件（plan.* / conflict.* / replan.* 等）
 * 立即 flush，逐条按序应用。单调守卫 / 缺口检测 / Last-Event-ID 语义保持不变：
 * 缺口检测以「批次窗口内收到的最小 seq」为基准，合并丢弃的中间 seq 不误报缺口。
 *
 * 说明：后端该端点需要 `Authorization: Bearer` 头，原生 `EventSource` 无法携带
 * 自定义请求头，因此这里用 `fetch` + ReadableStream 手动解析 SSE 上报协议
 * （与 EventSource 语义一致：`event:` / `id:` / `data:` 字段）。
 */

export type SchedulerStreamStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'error';

/** 便于外部直接引用 V2 枚举类型（透传自 schedulerRealtimeCore）。 */
export type { SchedulerStreamStatusV2 } from '@client/src/pages/CommandMap/hooks/schedulerRealtimeCore';

interface UseSchedulerStreamOptions {
  /** 是否启用（默认 true）。 */
  enabled?: boolean;
  /** 轮询兜底间隔（SSE 断开时）。 */
  pollIntervalMs?: number;
  /** 连续错误达到该次数后切换到轮询兜底。 */
  maxConsecutiveErrors?: number;
  /** 轮询期间尝试重连 SSE 的间隔。 */
  reconnectIntervalMs?: number;
  /** 检测到 sequence 缺口 / 需要全量重同步时回调（默认：失效调度相关查询）。 */
  onResync?: () => void;
  /** Task 11/11.1：SSE 批处理合并窗口（ms）；0 表示禁用批处理（逐条应用）。 */
  batchWindowMs?: number;
}

const STREAM_PATH = '/api/scheduler/v2/stream';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_RECONNECT_INTERVAL_MS = 15_000;
/** Task 11/11.1：高频事件合并窗口（ms），快速突发（遥测/位置）合并为一次 store 写出。 */
const DEFAULT_BATCH_WINDOW_MS = 80;
/** CLI-704：连续失败计数的时间窗——窗口外的旧失败衰减清零。 */
const ERROR_WINDOW_MS = 60_000;

function streamUrl(): string {
  const base = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_API_BASE_URL || '';
  return `${base}${STREAM_PATH}`;
}

/** 解析一条 SSE 事件块（由多条 `\n` 分隔的字段组成）。 */
interface ParsedEvent {
  event?: string;
  id?: string;
  data?: string;
}

function parseSseBlock(block: string): ParsedEvent {
  const parsed: ParsedEvent = {};
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) parsed.event = line.slice(6).trim();
    else if (line.startsWith('id:')) parsed.id = line.slice(3).trim();
    else if (line.startsWith('data:')) parsed.data = line.slice(5).trim();
  }
  return parsed;
}

/** 将某方案合并/更新进「活跃方案」缓存列表（按 planId 去重）。 */
function mergePlanIntoActive(
  prev: SchedulingPlanV2[] | undefined,
  plan: SchedulingPlanV2,
): SchedulingPlanV2[] {
  const list = prev ?? [];
  const idx = list.findIndex((p) => p.planId === plan.planId);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = plan;
    return next;
  }
  return [...list, plan];
}

export function useSchedulerStream(options: UseSchedulerStreamOptions = {}): {
  status: SchedulerStreamStatus;
  /** V2 对外健康状态（CONNECTED / DEGRADED / RESYNCING / OFFLINE）。 */
  statusV2: SchedulerStreamStatusV2;
  /** 最近一条已应用事件的 epoch ms（无则 null）。 */
  lastEventTime: number | null;
  /** 最近一次全量重同步负载中的快照版本（无则 null）。 */
  snapshotVersion: string | null;
  /** 最近已确认的 outbox sequence（单调游标）。 */
  lastSequence: number;
  /** 手动触发全量重同步（失效决策关键查询）。 */
  triggerResync: () => void;
} {
  const {
    enabled = true,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
    reconnectIntervalMs = DEFAULT_RECONNECT_INTERVAL_MS,
    batchWindowMs = DEFAULT_BATCH_WINDOW_MS,
    onResync,
  } = options;

  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SchedulerStreamStatus>('idle');
  // Task 2.2：对外暴露更丰富的实时状态（供 Provider / UI 徽标展示）。
  const [lastEventTime, setLastEventTime] = useState<number | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState<string | null>(null);
  const [lastSequence, setLastSequence] = useState<number>(0);
  const [resyncing, setResyncing] = useState<boolean>(false);

  // refs：避免闭包过期，同时保证 effect 内读取最新值。
  const abortRef = useRef<AbortController | null>(null);
  const lastSequenceRef = useRef<number>(0);
  const lastEventIdRef = useRef<string | null>(null);
  const consecutiveErrorsRef = useRef<number>(0);
  // CLI-704：连续失败计数的时间窗起点——跨窗口的间歇失败不累计切轮询。
  const errorStreakStartRef = useRef<number>(0);
  const pollingRef = useRef<boolean>(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  // 用于在 connect 内部自引用（重连）时绕过 TDZ。
  const connectRef = useRef<() => void>(() => undefined);

  /** 全量重同步：放弃增量，从后端拉取权威状态（P0-1 / P3-T2）。 */
  const triggerResync = useCallback(() => {
    // 活动重同步期间对外暴露 RESYNCING（权威重建中，不猜测缺口内状态）。
    setResyncing(true);
    // 权威端点并行失效重建：活跃方案 / 世界快照 / 资源投影 / 冲突 / 方案详情 / 运行 / 路由。
    // P0：routes 纳入 resync——route.changed 事件缺口后必须重拉路由图与路由成本，
    // 否则地图路线与 Solver 使用的 RouteCost 不一致（缺口内状态不猜测，一律权威恢复）。
    // 注意：快照/冲突的 queryKey 是 ['scheduler','snapshot'] / ['scheduler','conflicts',{}]，
    // 必须与 useCommandMapSchedulerState 使用的 queryKeys.schedulerSnapshot / schedulerConflicts 一致，
    // 否则 resync 失效不到这些查询（P0-4 语义：缺口后权威重建字典关键读模型）。
    for (const key of pollingInvalidateKeys()) {
      queryClient.invalidateQueries({ queryKey: key });
    }
    // P1（2026-08-19 审计）：路由图 queryKey 统一为 ['scheduler-routes']
    // （pollingInvalidateKeys 已含）——此前 useCommandMapQueries 用
    // ['schedule-route-graph']、useCommandMapSchedulerState 用
    // ['scheduler-routes'] 双缓存同一 getRoutes，resync 只失效其中一份，
    // 断线恢复后两处路线图版本不一致。此行原失效旧 key，现保底清理残留
    // 旧缓存条目（升级过渡期无消费者，仅释放内存）。
    queryClient.removeQueries({ queryKey: ['schedule-route-graph'] });
    // 使用前缀匹配，使所有 ['scheduler-plan', planId] / ['scheduler-run', runId] 都失效。
    queryClient.invalidateQueries({ queryKey: ['scheduler-plan'] });
    queryClient.invalidateQueries({ queryKey: ['scheduler-run'] });
    onResyncRef.current?.();
  }, [queryClient]);

  /**
   * 处理服务端 resync 事件：放弃旧增量基线，触发全量重同步并重置续传游标。
   * - 以服务器权威 currentSequence 为新基线：缺口内事件由全量重拉恢复，
   *   之后到达的实时事件（sequence > currentSequence）继续增量处理；
   * - lastEventIdRef 重置为当前基线，确保下次重连不再携带旧 id（避免重复 resync）。
   */
  const handleResync = useCallback(
    (data: string) => {
      // Task 11/11.1：resync 为权威重建，先 flush 积压增量（保持接收顺序），
      // 再以服务器权威 currentSequence 重置基线（积压中 <= 基线的事件由守卫自然丢弃）。
      batcherRef.current?.flush();
      try {
        const payload = JSON.parse(data) as {
          currentSequence?: number;
          reason?: string;
          snapshotVersion?: string;
        };
        const current =
          typeof payload.currentSequence === 'number'
            ? payload.currentSequence
            : lastSequenceRef.current;
        lastSequenceRef.current = current;
        setLastSequence(current);
        // Task 2.2：resync 负载若携带权威快照版本则透传给 UI（无则保持 null）。
        if (typeof payload.snapshotVersion === 'string') {
          setSnapshotVersion(payload.snapshotVersion);
        }
        lastEventIdRef.current = String(current);
        triggerResync();
      } catch {
        // 无法解析的 resync 事件也按全量重同步兜底。
        lastEventIdRef.current = null;
        triggerResync();
      }
    },
    [triggerResync],
  );

  /**
   * 逐条应用事件（Task 11/11.1：批内事件按序应用，业务语义逐条保留）。
   * 游标推进/状态更新由批次 flush 统一处理，避免每事件一次 React 渲染。
   */
  const applyEvent = useCallback(
    (event: SchedulingEvent) => {
      const type = event.eventType ?? '';
      // 由事件类型推断受影响的 planId。
      let planId: string | null = null;
      if (type.startsWith('plan.')) {
        planId = event.entityId;
      } else if (event.payload && typeof event.payload === 'object') {
        const pid = (event.payload as Record<string, unknown>).planId;
        if (typeof pid === 'string') planId = pid;
      }

      if (planId) {
        // 事件载荷不包含完整方案，需拉取详情后写入缓存（详情 + 活跃列表）。
        getPlan(planId)
          .then((plan) => {
            if (!plan) return;
            queryClient.setQueryData(queryKeys.schedulerPlan(plan.planId), plan);
            queryClient.setQueryData<SchedulingPlanV2[]>(
              queryKeys.schedulerActivePlans,
              (prev) => mergePlanIntoActive(prev, plan),
            );
          })
          .catch(() => {
            // 拉取失败时退化为失效该详情查询，下次读取时重试。
            queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlan(planId as string) });
          });
      } else if (type.startsWith('run.')) {
        const runId = event.entityId;
        if (runId) queryClient.invalidateQueries({ queryKey: queryKeys.schedulerRun(runId) });
      }

      // v0.7 B3：新冲突实时推送 → 失效冲突查询（冲突中心立即刷新）。
      if (type === 'conflict.detected') {
        queryClient.invalidateQueries({ queryKey: queryKeys.schedulerConflicts() });
      }
      // v0.7 B3：执行偏差回填 → 失效方案详情（地图执行偏差图层数据更新）。
      if (type === 'execution.deviation') {
        const pid = (event.payload as Record<string, unknown>)?.planId;
        if (typeof pid === 'string') {
          queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlan(pid) });
        }
        // v0.7 Batch7.1：执行变化 → 失效世界状态（地图实体位置提前刷新，
        // 等效"近实时"，2s 轮询作为兜底保底；避免直接改 FactoryMap 渲染链的高风险）。
        queryClient.invalidateQueries({ queryKey: queryKeys.worldState });
      }
    },
    [queryClient],
  );

  /**
   * 应用一个事件批次（Task 11/11.1）。
   * - 缺口检测以「批次窗口内收到的最小 seq」与上一批次游标比较：窗口内已完整接收
   *   （只是合并丢弃了中间遥测），故合并不产生伪缺口；
   * - 批次内事件按 sequence 升序逐条应用（applyEvent），业务事件顺序不变；
   * - 游标推进到批次最大 seq，Last-Event-ID 同步更新（合并丢弃的中间 seq 不会
   *   在重连时被要求重放，因为服务端游标与客户端一致）。
   */
  const applyEventBatch = useCallback(
    (batch: EventBatch<SchedulingEvent>) => {
      // 缺口检测：批次起点与上一批次接收游标不连续 → 增量无法安全续接 → 全量 resync。
      if (lastSequenceRef.current > 0 && batch.minSeq > lastSequenceRef.current + 1) {
        lastSequenceRef.current = batch.maxSeq;
        setLastSequence(batch.maxSeq);
        lastEventIdRef.current = String(batch.maxSeq);
        triggerResync();
        return;
      }
      // 单调守卫：批内已按 seq 升序去重，此守卫兜底跨批次重复/回退事件。
      for (const event of batch.events) {
        if (event.sequence <= lastSequenceRef.current) continue;
        applyEvent(event);
      }
      lastSequenceRef.current = batch.maxSeq;
      setLastSequence(batch.maxSeq);
      // Last-Event-ID 续传游标 = outbox sequence（与 SSE id 字段一致，重连时原样回传）。
      lastEventIdRef.current = String(batch.maxSeq);
      // 批次成功应用 → 记录最近事件时间并清除重同步标记（恢复实时增量）。
      setLastEventTime(Date.now());
      setResyncing(false);
    },
    [applyEvent, triggerResync],
  );

  // Task 11/11.1：事件批处理器（懒创建一次；onFlush 引用稳定）。
  const batcherRef = useRef<EventBatcher<SchedulingEvent> | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = createEventBatcher<SchedulingEvent>({
      windowMs: batchWindowMs,
      onFlush: applyEventBatch,
    });
  }

  /**
   * 处理单个调度事件（入口）：重复事件在入批前剔除；结构性事件由 batcher 即时 flush。
   */
  const handleEvent = useCallback(
    (event: SchedulingEvent) => {
      // 预过滤：sequence <= 已接收游标 → 重复/回退事件（不进入批处理）。
      if (event.sequence <= lastSequenceRef.current) return;
      batcherRef.current?.push(event);
    },
    [],
  );

  /** 启动轮询兜底：定时刷新决策关键查询，并周期性尝试重连 SSE。 */
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setStatus('polling');
    // Task 2.3/2.4：轮询兜底需刷新与 `triggerResync` 相同的决策关键读模型——
    // 仅刷新活跃方案会导致快照/资源/冲突/路由在 SSE 断开期间停留在陈旧状态，
    // 地图叠加层与冲突中心会展示过时数据。故一并失效快照、资源、冲突、路由。
    pollTimerRef.current = setInterval(() => {
      for (const key of pollingInvalidateKeys()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    }, pollIntervalMs);
  }, [pollIntervalMs, queryClient]);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    // 取消上一次连接。
    abortRef.current?.abort();

    const abort = new AbortController();
    abortRef.current = abort;

    const token = getAccessToken();
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // P2 收尾：SSE 增量续传——断线重连携带 Last-Event-ID（outbox sequence），
    // 服务端据此重放缺失事件；首次连接（null）行为与历史一致（全量订阅）。
    // 同源部署下自定义 header 无 CORS 预检问题。
    if (lastEventIdRef.current) headers['Last-Event-ID'] = lastEventIdRef.current;

    setStatus('connecting');

    fetch(streamUrl(), {
      headers,
      signal: abort.signal,
    })
      .then((res) => {
        if (!res.ok || !res.body) {
          throw new Error(`SSE HTTP ${res.status}`);
        }
        return res.body;
      })
      .then((body) => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let first = true;

        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              handleStreamEnd('stream ended');
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            // 按空行切分事件块。
            let sepIndex: number;
            while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, sepIndex);
              buffer = buffer.slice(sepIndex + 2);
              const parsed = parseSseBlock(block);
              if (first) {
                // 首条数据到达即视为连接成功。
                first = false;
                consecutiveErrorsRef.current = 0;
                if (pollingRef.current) stopPolling();
                setStatus('live');
                // Task 2.2：连接恢复 / 实时可达 → 退出重同步标记。
                setResyncing(false);
              }
              if (!parsed.data) continue;
              // 任意带 id 的事件（scheduling.event / resync）都推进续传游标。
              if (parsed.id) lastEventIdRef.current = parsed.id;
              if (parsed.event === 'heartbeat') {
                continue;
              }
              if (parsed.event === 'error') {
                // P2（2026-08-19 审计）：服务端 error 帧（鉴权失效/限流/内部
                // 错误）必须终止消费循环——原实现落入所有分支后继续 pump()，
                // 错误被静默吞掉、连接僵死继续读。
                handleStreamEnd(`server error: ${parsed.data.slice(0, 200)}`);
                abort.abort();
                return;
              }
              if (parsed.event === 'resync') {
                // 服务端判定缺口/客户端超前：放弃增量、走全量重同步（P2 收尾）。
                handleResync(parsed.data);
                continue;
              }
              if (parsed.event === 'scheduling.event') {
                try {
                  const event = JSON.parse(parsed.data) as SchedulingEvent;
                  handleEvent(event);
                } catch {
                  // 忽略无法解析的事件。
                }
              }
            }
            return pump();
          });

        return pump();
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return; // 主动取消，不视为错误。
        handleStreamEnd(err instanceof Error ? err.message : String(err));
      });

    function handleStreamEnd(reason: string): void {
      if (abort.signal.aborted) return;
      // CLI-704：失败计数按时间窗衰减——窗口（ERROR_WINDOW_MS）之外的
      // 旧失败不计入本次连续计数，避免长周期偶发瞬断逐步累积而误切轮询；
      // 只有窗口内的密集失败才达到 maxConsecutiveErrors 触发降级。
      const now = Date.now();
      if (consecutiveErrorsRef.current > 0 && now - errorStreakStartRef.current > ERROR_WINDOW_MS) {
        consecutiveErrorsRef.current = 0;
      }
      if (consecutiveErrorsRef.current === 0) {
        errorStreakStartRef.current = now;
      }
      consecutiveErrorsRef.current += 1;
      if (consecutiveErrorsRef.current >= maxConsecutiveErrors && !pollingRef.current) {
        startPolling();
      } else if (!pollingRef.current) {
        setStatus('error');
      }
      // 无论是否进入轮询，都安排一次 SSE 重连，恢复后自动切回实时。
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (abortRef.current === abort) connectRef.current?.();
      }, reconnectIntervalMs);
      void reason;
    }
  }, [handleEvent, handleResync, maxConsecutiveErrors, reconnectIntervalMs, startPolling, stopPolling]);

  connectRef.current = connect;

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      // Task 11/11.1：卸载前 flush 积压（丢失最后窗口的事件），随后释放批处理器。
      // CLI-703：dispose 后置 null——enabled true→false→true 重新启用时，
      // 懒创建分支会重建 batcher；否则事件会被 push 进已 dispose 的实例而丢失。
      batcherRef.current?.flush();
      batcherRef.current?.dispose();
      batcherRef.current = null;
      abortRef.current?.abort();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      pollingRef.current = false;
    };
  }, [enabled, connect]);

  // Task 2.2：对外暴露更丰富的实时状态（V2 枚举 + 事件时间 + 快照版本 + 游标 + 手动重同步）。
  return {
    status,
    statusV2: mapToV2Status({ status, resyncing }),
    lastEventTime,
    snapshotVersion,
    lastSequence,
    triggerResync,
  };
}