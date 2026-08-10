/* Task 6：Outbox → Postgres LISTEN/NOTIFY 低延迟 wake-up（scheduler-stream.service 单元测试）。
 *
 * 覆盖：
 *   a) 注入 mock listener → 收到通知立即触发一次 poll（不等 2s 轮询），新事件被推送；
 *   b) listener 订阅抛错 → 降级纯轮询：2s 定时器照常推送事件（NOTIFY 不是唯一事实源）；
 *   c) 未提供 listener（缺省）→ 行为与现状一致（仅轮询）；
 *   d) sequence 去重/推进语义不变（重复通知不重复推送，新 sequence 照常推送）；
 *   e) unsubscribe 抛错 → stop() 不抛（仅告警），定时器已清理。
 *
 * 构造签名向后兼容性由现有 phase2-realtime / last-event-id / sse-events spec 全绿保证
 * （`new SchedulerStreamService(outboxService)` 单参构造不受影响）。
 */
/// <reference types="jest" />
import { SchedulerStreamService, type SchedulerOutboxListener } from '../scheduler-stream.service';
import type { OutboxEvent, SchedulingEvent } from '@shared/api.interface';

const POLL_INTERVAL_MS = 2_000;

function evt(sequence: number): OutboxEvent {
  return {
    id: `evt-${sequence}`,
    eventType: 'DEVICE_OFFLINE',
    entityId: 'd1',
    payload: {},
    status: 'published',
    sequence,
    createdAt: new Date().toISOString(),
  };
}

function makeOutbox(listLatestImpl?: jest.Mock) {
  return {
    latestSequence: jest.fn().mockResolvedValue(0),
    listSince: jest.fn().mockResolvedValue([]),
    listLatest: listLatestImpl ?? jest.fn().mockResolvedValue([]),
  };
}

/** 等待微任务清空（poll 的异步 mock 链 resolve 到 subject.next）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** mock listener：subscribe 记录 onNotify 回调，fire() 模拟收到 DB 通知。 */
function makeListener() {
  let onNotify: (() => void) | null = null;
  const listener: SchedulerOutboxListener = {
    subscribe: jest.fn((cb: () => void) => {
      onNotify = cb;
      return jest.fn();
    }),
  };
  return { listener, fire: () => onNotify?.() };
}

/** mock metricsService（Task 3 埋点）：结构近似 SchedulerMetricsService 的 4 个实时指标方法。 */
function makeMetrics() {
  return {
    recordNotifyWakeup: jest.fn(),
    recordPollFallback: jest.fn(),
    recordListenerReconnect: jest.fn(),
    recordResync: jest.fn(),
  };
}

describe('SchedulerStreamService OUTBOX LISTEN/NOTIFY wake-up（Task 6）', () => {
  it('收到通知 → 立即触发一次 poll（不等 2s 轮询），新事件被推送', async () => {
    const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
    const { listener, fire } = makeListener();
    const svc = new SchedulerStreamService(outbox as never, listener);
    const events: SchedulingEvent[] = [];
    const sub = svc.events().subscribe((e) => events.push(e));

    await svc.start();
    expect(listener.subscribe).toHaveBeenCalledTimes(1);
    // 启动本身不立即 poll（仅启动 2s 定时器）。
    expect(outbox.listLatest).not.toHaveBeenCalled();

    fire();
    await flush();
    expect(outbox.listLatest).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.sequence)).toEqual([1]);

    sub.unsubscribe();
    svc.stop();
  });

  it('notify listener 订阅抛错 → 降级纯轮询：2s 定时器照常推送事件', async () => {
    jest.useFakeTimers();
    try {
      const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
      const throwingListener: SchedulerOutboxListener = {
        subscribe: jest.fn(() => {
          throw new Error('listener subscribe boom');
        }),
      };
      const svc = new SchedulerStreamService(outbox as never, throwingListener);
      const events: SchedulingEvent[] = [];
      const sub = svc.events().subscribe((e) => events.push(e));

      await svc.start();
      expect(throwingListener.subscribe).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);

      // 轮询兜底：推进一个 2s 周期后事件仍被推送（NOTIFY 失败不影响事件交付）。
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(outbox.listLatest).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.sequence)).toEqual([1]);

      svc.stop();
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });

  it('未提供 notify listener（缺省）→ 行为与现状一致：仅 2s 轮询推送', async () => {
    jest.useFakeTimers();
    try {
      const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
      const svc = new SchedulerStreamService(outbox as never);
      const events: SchedulingEvent[] = [];
      const sub = svc.events().subscribe((e) => events.push(e));

      await svc.start();
      expect(outbox.listLatest).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(outbox.listLatest).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.sequence)).toEqual([1]);

      svc.stop();
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sequence 去重/推进语义不变：重复通知不重复推送，新 sequence 照常推送', async () => {
    const outbox = makeOutbox(
      jest
        .fn()
        .mockResolvedValueOnce([evt(1)])
        .mockResolvedValueOnce([evt(1), evt(2)]),
    );
    const { listener, fire } = makeListener();
    const svc = new SchedulerStreamService(outbox as never, listener);
    const events: SchedulingEvent[] = [];
    const sub = svc.events().subscribe((e) => events.push(e));

    await svc.start();
    expect(listener.subscribe).toHaveBeenCalledTimes(1);

    fire();
    await flush();
    expect(events.map((e) => e.sequence)).toEqual([1]);

    // 第二次通知：seq1 已在 lastSequence/seenEventIds 内 → 去重；seq2 新推送。
    fire();
    await flush();
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);

    sub.unsubscribe();
    svc.stop();
  });

  it('unsubscribe 抛错 → stop() 不抛（仅告警），轮询定时器已清理', async () => {
    const listener: SchedulerOutboxListener = {
      subscribe: jest.fn(() => () => {
        throw new Error('unsubscribe boom');
      }),
    };
    const svc = new SchedulerStreamService(makeOutbox() as never, listener);
    await svc.start();
    expect(listener.subscribe).toHaveBeenCalledTimes(1);

    expect(() => svc.stop()).not.toThrow();
    // 幂等：重复 stop 同样不抛。
    expect(() => svc.stop()).not.toThrow();
  });

  // ---- Task 3 埋点：Realtime 可观测指标（notify wakeup / poll fallback / resync） ----

  it('埋点：NOTIFY 触发 poll 记录 recordNotifyWakeup；listener 启用时定时轮询不计 fallback', async () => {
    jest.useFakeTimers();
    try {
      const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
      const { listener, fire } = makeListener();
      const metrics = makeMetrics();
      const svc = new SchedulerStreamService(outbox as never, listener, metrics as never);
      const events: SchedulingEvent[] = [];
      const sub = svc.events().subscribe((e) => events.push(e));

      await svc.start();
      expect(listener.subscribe).toHaveBeenCalledTimes(1);

      // NOTIFY wake-up：即时 poll + 计数
      fire();
      await jest.advanceTimersByTimeAsync(0);
      expect(outbox.listLatest).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.sequence)).toEqual([1]);
      expect(metrics.recordNotifyWakeup).toHaveBeenCalledTimes(1);
      expect(metrics.recordPollFallback).not.toHaveBeenCalled();

      // listener 启用成功 → 定时轮询兜底不计 fallback
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(metrics.recordPollFallback).not.toHaveBeenCalled();

      sub.unsubscribe();
      svc.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('埋点：未提供 listener → 每次定时 poll 记录 recordPollFallback', async () => {
    jest.useFakeTimers();
    try {
      const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
      const metrics = makeMetrics();
      const svc = new SchedulerStreamService(outbox as never, undefined, metrics as never);
      const events: SchedulingEvent[] = [];
      const sub = svc.events().subscribe((e) => events.push(e));

      await svc.start();
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(outbox.listLatest).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.sequence)).toEqual([1]);
      expect(metrics.recordPollFallback).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
      svc.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('埋点：listener 订阅抛错 → 降级轮询路径每次 poll 记录 recordPollFallback', async () => {
    jest.useFakeTimers();
    try {
      const outbox = makeOutbox(jest.fn().mockResolvedValue([evt(1)]));
      const throwingListener: SchedulerOutboxListener = {
        subscribe: jest.fn(() => {
          throw new Error('listener subscribe boom');
        }),
      };
      const metrics = makeMetrics();
      const svc = new SchedulerStreamService(outbox as never, throwingListener, metrics as never);
      const events: SchedulingEvent[] = [];
      const sub = svc.events().subscribe((e) => events.push(e));

      await svc.start();
      expect(throwingListener.subscribe).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(outbox.listLatest).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.sequence)).toEqual([1]);
      expect(metrics.recordPollFallback).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
      svc.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('埋点：replaySince 检测到 sequence 缺口 → recordResync；客户端超前 → recordResync', async () => {
    const metrics = makeMetrics();

    // 分支一：缺口（base+1 与首条回放 sequence 不连续）
    const gapOutbox = {
      latestSequence: jest.fn().mockResolvedValue(10),
      listSince: jest.fn().mockResolvedValue([evt(5)]),
      listLatest: jest.fn().mockResolvedValue([]),
    };
    const gapSvc = new SchedulerStreamService(gapOutbox as never, undefined, metrics as never);
    const gapResult = await gapSvc.replaySince(1);
    expect(gapResult.resyncNeeded).toBe(true);
    expect(metrics.recordResync).toHaveBeenCalledTimes(1);

    // 分支二：客户端 sequence 超前于服务器最新
    const aheadOutbox = {
      latestSequence: jest.fn().mockResolvedValue(3),
      listSince: jest.fn().mockResolvedValue([]),
      listLatest: jest.fn().mockResolvedValue([]),
    };
    const aheadSvc = new SchedulerStreamService(aheadOutbox as never, undefined, metrics as never);
    const aheadResult = await aheadSvc.replaySince(5);
    expect(aheadResult.resyncNeeded).toBe(true);
    expect(metrics.recordResync).toHaveBeenCalledTimes(2);
  });
});
