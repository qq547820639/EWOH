/* Task 2.1：调度实时状态单例 Provider。
 *
 * 归一化 CommandMap / SchedulePanel / Scheduling 三处对 `useSchedulerStream` 的独立订阅，
 * 收敛为唯一一条 Scheduler SSE 连接。Provider 内部只调用一次 `useSchedulerStream()`，
 * 通过 React Context 把实时状态（status / statusV2 / lastEventTime / snapshotVersion /
 * lastSequence / triggerResync）分发给所有消费方。
 *
 * 注意：Provider 必须在应用的 QueryClientProvider 内部渲染（useSchedulerStream 依赖 React Query）。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSchedulerStream, type SchedulerStreamStatus } from '@client/src/hooks/useSchedulerStream';
import type { SchedulerStreamStatusV2 } from '@client/src/pages/CommandMap/hooks/schedulerRealtimeCore';

export interface SchedulerRealtimeState {
  /** 内部状态（旧枚举，向后兼容）。 */
  status: SchedulerStreamStatus;
  /** 对外健康状态（V2 枚举）。 */
  statusV2: SchedulerStreamStatusV2;
  /** 最近一条已应用事件的 epoch ms（无则 null）。 */
  lastEventTime: number | null;
  /** 最近一次全量重同步负载中的快照版本（无则 null）。 */
  snapshotVersion: string | null;
  /** 最近已确认的 outbox sequence。 */
  lastSequence: number;
  /** 手动触发全量重同步。 */
  triggerResync: () => void;
}

/** 单例流上下文：由 SchedulerRealtimeProvider 提供，未包裹时访问抛错以防误用。 */
export const SchedulerRealtimeContext = createContext<SchedulerRealtimeState | null>(null);

export function SchedulerRealtimeProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  // 唯一一次订阅：全局只有这一条 Scheduler SSE 连接。
  const stream = useSchedulerStream();

  const value = useMemo<SchedulerRealtimeState>(
    () => ({
      status: stream.status,
      statusV2: stream.statusV2,
      lastEventTime: stream.lastEventTime,
      snapshotVersion: stream.snapshotVersion,
      lastSequence: stream.lastSequence,
      triggerResync: stream.triggerResync,
    }),
    [
      stream.status,
      stream.statusV2,
      stream.lastEventTime,
      stream.snapshotVersion,
      stream.lastSequence,
      stream.triggerResync,
    ],
  );

  return <SchedulerRealtimeContext.Provider value={value}>{children}</SchedulerRealtimeContext.Provider>;
}

/** 读取调度实时状态；必须在 SchedulerRealtimeProvider 内调用。 */
export function useSchedulerRealtime(): SchedulerRealtimeState {
  const ctx = useContext(SchedulerRealtimeContext);
  if (!ctx) {
    throw new Error('useSchedulerRealtime must be used within <SchedulerRealtimeProvider>');
  }
  return ctx;
}