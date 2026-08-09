import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getPlan } from '@client/src/api/scheduler';
import { getAccessToken } from '@client/src/lib/auth';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type { SchedulingEvent, SchedulingPlanV2 } from '@shared/api.interface';

/**
 * 调度实时事件流 Hook（SSE）。
 *
 * 消费后端 `GET /api/scheduler/v2/stream`，将事件增量写入 React Query 缓存，
 * 并处理：sequence 去重、Last-Event-ID 续传、缺口检测→全量重同步（resync）、
 * SSE 失败→轮询兜底→恢复后回到 SSE。
 *
 * 说明：后端该端点需要 `Authorization: Bearer` 头，原生 `EventSource` 无法携带
 * 自定义请求头，因此这里用 `fetch` + ReadableStream 手动解析 SSE 上报协议
 * （与 EventSource 语义一致：`event:` / `id:` / `data:` 字段）。
 */

export type SchedulerStreamStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'error';

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
}

const STREAM_PATH = '/api/scheduler/v2/stream';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_RECONNECT_INTERVAL_MS = 15_000;

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
} {
  const {
    enabled = true,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
    reconnectIntervalMs = DEFAULT_RECONNECT_INTERVAL_MS,
    onResync,
  } = options;

  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SchedulerStreamStatus>('idle');

  // refs：避免闭包过期，同时保证 effect 内读取最新值。
  const abortRef = useRef<AbortController | null>(null);
  const lastSequenceRef = useRef<number>(0);
  const lastEventIdRef = useRef<string | null>(null);
  const consecutiveErrorsRef = useRef<number>(0);
  const pollingRef = useRef<boolean>(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  // 用于在 connect 内部自引用（重连）时绕过 TDZ。
  const connectRef = useRef<() => void>(() => undefined);

  /** 全量重同步：放弃增量，从后端拉取权威状态（P0-1 / P3-T2）。 */
  const triggerResync = useCallback(() => {
    // 权威端点并行失效重建：活跃方案 / 世界快照 / 资源投影 / 冲突 / 方案详情 / 运行。
    // 缺口内状态不猜测，一律从后端权威数据恢复。
    queryClient.invalidateQueries({ queryKey: ['scheduler-active-plans'] });
    queryClient.invalidateQueries({ queryKey: ['scheduler-snapshot'] });
    queryClient.invalidateQueries({ queryKey: ['scheduler-resource-state'] });
    queryClient.invalidateQueries({ queryKey: ['scheduler-conflicts'] });
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
      try {
        const payload = JSON.parse(data) as { currentSequence?: number; reason?: string };
        const current =
          typeof payload.currentSequence === 'number'
            ? payload.currentSequence
            : lastSequenceRef.current;
        lastSequenceRef.current = current;
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

  /** 处理单个调度事件 → 写入缓存。 */
  const handleEvent = useCallback(
    (event: SchedulingEvent) => {
      // sequence 去重：重复事件（sequence <= lastSequence）不重复执行业务逻辑。
      if (event.sequence <= lastSequenceRef.current) return;

      // 缺口检测：跳过了中间事件，增量无法安全续接 → 全量重同步。
      if (lastSequenceRef.current > 0 && event.sequence > lastSequenceRef.current + 1) {
        lastSequenceRef.current = event.sequence;
        lastEventIdRef.current = String(event.sequence);
        triggerResync();
        return;
      }

      lastSequenceRef.current = event.sequence;
      // Last-Event-ID 续传游标 = outbox sequence（与 SSE id 字段一致，重连时原样回传）。
      lastEventIdRef.current = String(event.sequence);

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
    [queryClient, triggerResync],
  );

  /** 启动轮询兜底：定时刷新活跃方案查询，并周期性尝试重连 SSE。 */
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setStatus('polling');
    // 轮询：刷新活跃方案查询（getActivePlans 返回缓存维护的列表）。
    pollTimerRef.current = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerActivePlans });
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
              }
              if (!parsed.data) continue;
              // 任意带 id 的事件（scheduling.event / resync）都推进续传游标。
              if (parsed.id) lastEventIdRef.current = parsed.id;
              if (parsed.event === 'heartbeat') {
                continue;
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
      abortRef.current?.abort();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      pollingRef.current = false;
    };
  }, [enabled, connect]);

  return { status };
}