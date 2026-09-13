/* Phase 3 / P3-T2 前端：SSE 实时核心纯函数测试。
 *
 * 覆盖：sequence 单调守卫 / 缺口检测 / resync 基线重置 / 轮询兜底决策 /
 * 三源（sse/resync/poll）单调防回退。
 */
import {
  nextSequence,
  resyncBaseline,
  nextStreamState,
  mergeSourceSequence,
  mapToV2Status,
  pollingInvalidateKeys,
  isContextStale,
  isStructuralEventType,
  coalesceEvents,
  createEventBatcher,
  type EventBatch,
} from './schedulerRealtimeCore';
import { queryKeys } from '@client/src/hooks/queryKeys';

describe('schedulerRealtimeCore.nextSequence（单调守卫 + 缺口检测）', () => {
  it('正常增量 seq = last + 1 → accept 且无 gap', () => {
    expect(nextSequence(5, 6)).toEqual({ accept: true, gap: false, lastSequence: 6 });
  });

  it('重复/回退 seq <= last → 丢弃（不推进游标）', () => {
    expect(nextSequence(5, 5)).toEqual({ accept: false, gap: false, lastSequence: 5 });
    expect(nextSequence(5, 3)).toEqual({ accept: false, gap: false, lastSequence: 5 });
  });

  it('跳号 seq > last + 1 → gap=true（需要全量 resync）', () => {
    expect(nextSequence(5, 8)).toEqual({ accept: true, gap: true, lastSequence: 8 });
  });

  it('首次/基线 last=0 → 接受任意 seq（新基线）', () => {
    expect(nextSequence(0, 42)).toEqual({ accept: true, gap: false, lastSequence: 42 });
  });

  it('非法 seq（NaN/负数）→ 丢弃', () => {
    expect(nextSequence(3, Number.NaN).accept).toBe(false);
    expect(nextSequence(3, -1).accept).toBe(false);
  });
});

describe('schedulerRealtimeCore.resyncBaseline（全量重建基线重置）', () => {
  it('以服务器权威 currentSequence 为新基线', () => {
    expect(resyncBaseline(0, 99)).toBe(99);
    expect(resyncBaseline(50, 100)).toBe(100);
  });

  it('非法 currentSequence → 保持旧基线', () => {
    expect(resyncBaseline(50, Number.NaN)).toBe(50);
    expect(resyncBaseline(50, -1)).toBe(50);
  });
});

describe('schedulerRealtimeCore.nextStreamState（轮询兜底决策）', () => {
  it('连续错误未达阈值 → error（不启动轮询）', () => {
    expect(
      nextStreamState({ consecutiveErrors: 2, maxConsecutiveErrors: 3, currentlyPolling: false }),
    ).toEqual({ status: 'error', shouldStartPolling: false });
  });

  it('连续错误达到阈值 → 切换到轮询', () => {
    expect(
      nextStreamState({ consecutiveErrors: 3, maxConsecutiveErrors: 3, currentlyPolling: false }),
    ).toEqual({ status: 'polling', shouldStartPolling: true });
  });

  it('已在轮询 → 保持 polling（不重复启动）', () => {
    expect(
      nextStreamState({ consecutiveErrors: 1, maxConsecutiveErrors: 3, currentlyPolling: true }),
    ).toEqual({ status: 'polling', shouldStartPolling: false });
  });
});

describe('schedulerRealtimeCore.mergeSourceSequence（三源单调防回退）', () => {
  it('sse 增量源：严格 +1，跳号触发 gap', () => {
    expect(mergeSourceSequence('sse', 5, 6)).toEqual({ accept: true, gap: false, lastSequence: 6 });
    expect(mergeSourceSequence('sse', 5, 9).gap).toBe(true);
    expect(mergeSourceSequence('sse', 5, 5).accept).toBe(false);
  });

  it('resync/poll 全量源：以 observed 为新基线（允许跳号，不回退）', () => {
    expect(mergeSourceSequence('resync', 5, 42)).toEqual({ accept: true, gap: false, lastSequence: 42 });
    expect(mergeSourceSequence('poll', 5, 42)).toEqual({ accept: true, gap: false, lastSequence: 42 });
    // 回退（服务器游标倒退）→ 保守丢弃。
    expect(mergeSourceSequence('resync', 5, 3).accept).toBe(false);
  });
});

describe('schedulerRealtimeCore.mapToV2Status（内部状态 → V2 枚举）', () => {
  it('live → CONNECTED；idle/connecting → CONNECTED', () => {
    expect(mapToV2Status({ status: 'live', resyncing: false })).toBe('CONNECTED');
    expect(mapToV2Status({ status: 'idle', resyncing: false })).toBe('CONNECTED');
    expect(mapToV2Status({ status: 'connecting', resyncing: false })).toBe('CONNECTED');
  });

  it('polling → DEGRADED；error → OFFLINE', () => {
    expect(mapToV2Status({ status: 'polling', resyncing: false })).toBe('DEGRADED');
    expect(mapToV2Status({ status: 'error', resyncing: false })).toBe('OFFLINE');
  });

  it('活动重同步期间 → RESYNCING（无论内部状态）', () => {
    expect(mapToV2Status({ status: 'live', resyncing: true })).toBe('RESYNCING');
    expect(mapToV2Status({ status: 'polling', resyncing: true })).toBe('RESYNCING');
    expect(mapToV2Status({ status: 'error', resyncing: true })).toBe('RESYNCING');
  });
});

describe('schedulerRealtimeCore.pollingInvalidateKeys（轮询兜底刷新决策关键集）', () => {
  it('覆盖活跃方案 / 快照 / 资源 / 冲突 / 路由（Task 2.3/2.4）', () => {
    const keys = pollingInvalidateKeys();
    expect(keys).toContainEqual(queryKeys.schedulerActivePlans);
    expect(keys).toContainEqual(queryKeys.schedulerSnapshot);
    expect(keys).toContainEqual(queryKeys.schedulerResourceState);
    expect(keys).toContainEqual(queryKeys.schedulerConflicts());
    expect(keys).toContainEqual(['scheduler-routes']);
  });
});

describe('schedulerRealtimeCore.isContextStale（P1-D：STALE CONTEXT 判定）', () => {
  it('context 缺失（未拉到/加载中）→ 非 stale（无对照物，不误报）', () => {
    expect(isContextStale({ context: null, plans: [{ snapshotVersion: 'WS-1' }] })).toBe(false);
    expect(isContextStale({ context: null, plans: null })).toBe(false);
  });

  it('选中方案 snapshotVersion 与 context 不一致 → stale', () => {
    const context = { snapshotVersion: 'WS-2' };
    expect(isContextStale({ context, plans: [], activePlan: { snapshotVersion: 'WS-1' } })).toBe(true);
  });

  it('任一活跃方案与 context 不一致 → stale（即使选中方案一致）', () => {
    const context = { snapshotVersion: 'WS-2' };
    expect(
      isContextStale({
        context,
        plans: [{ snapshotVersion: 'WS-2' }, { snapshotVersion: 'WS-1' }],
        activePlan: { snapshotVersion: 'WS-2' },
      }),
    ).toBe(true);
  });

  it('全部方案与 context 一致 → 非 stale', () => {
    const context = { snapshotVersion: 'WS-2' };
    expect(
      isContextStale({ context, plans: [{ snapshotVersion: 'WS-2' }], activePlan: { snapshotVersion: 'WS-2' } }),
    ).toBe(false);
  });

  it('方案未声明 snapshotVersion → 不参与比较（无法核验，不误报）', () => {
    const context = { snapshotVersion: 'WS-2' };
    expect(isContextStale({ context, plans: [{ snapshotVersion: undefined }], activePlan: null })).toBe(false);
    expect(isContextStale({ context, plans: [], activePlan: { snapshotVersion: null } })).toBe(false);
  });

  it('无任何方案 → 非 stale', () => {
    expect(isContextStale({ context: { snapshotVersion: 'WS-2' }, plans: [], activePlan: null })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Task 11 / 11.1：SSE 批处理/合并（coalesceEvents / createEventBatcher）
 * ------------------------------------------------------------------ */

interface TestEvent {
  eventId: string;
  eventType: string;
  sequence: number;
}

function ev(id: string, eventType: string, sequence: number): TestEvent {
  return { eventId: id, eventType, sequence };
}

describe('schedulerRealtimeCore.isStructuralEventType（结构性业务事件识别）', () => {
  it('plan./conflict./replan./assignment./run./execution. 前缀为结构性事件', () => {
    expect(isStructuralEventType('plan.changed')).toBe(true);
    expect(isStructuralEventType('conflict.detected')).toBe(true);
    expect(isStructuralEventType('replan.started')).toBe(true);
    expect(isStructuralEventType('assignment.updated')).toBe(true);
    expect(isStructuralEventType('run.created')).toBe(true);
    expect(isStructuralEventType('execution.deviation')).toBe(true);
  });

  it('遥测/位置等高频事件不是结构性事件（进入合并窗口）', () => {
    expect(isStructuralEventType('device.telemetry')).toBe(false);
    expect(isStructuralEventType('position.updated')).toBe(false);
  });
});

describe('schedulerRealtimeCore.coalesceEvents（窗口内同类事件合并）', () => {
  it('同一类型（device.telemetry）只保留最新一条，输出按 sequence 升序', () => {
    const events = [
      ev('t1', 'device.telemetry', 1),
      ev('t2', 'device.telemetry', 2),
      ev('t3', 'device.telemetry', 3),
    ];
    const kept = coalesceEvents(events);
    expect(kept).toHaveLength(1);
    expect(kept[0].sequence).toBe(3);
  });

  it('结构性事件（plan./conflict.）全部保序保留，逐条语义不变', () => {
    const events = [
      ev('p1', 'plan.changed', 1),
      ev('t2', 'device.telemetry', 2),
      ev('c3', 'conflict.detected', 3),
    ];
    const kept = coalesceEvents(events);
    // 单条遥测保留（同类型仅一条无冗余）；结构性事件全部保序。
    expect(kept.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(kept.filter((e) => e.eventType.startsWith('plan.') || e.eventType.startsWith('conflict.'))).toHaveLength(2);
  });

  it('混合批次：遥测合并 + 结构性事件保序，最终按 sequence 升序', () => {
    const events = [
      ev('t1', 'device.telemetry', 1),
      ev('p2', 'plan.changed', 2),
      ev('t3', 'device.telemetry', 3),
      ev('c4', 'conflict.detected', 4),
      ev('t5', 'device.telemetry', 5),
    ];
    const kept = coalesceEvents(events);
    // 遥测只留 5；plan.changed(2)/conflict.detected(4) 原样保留；按 seq 升序。
    expect(kept.map((e) => e.sequence)).toEqual([2, 4, 5]);
  });

  it('keepPerType > 1 时保留同类型最近 N 条', () => {
    const events = [
      ev('t1', 'device.telemetry', 1),
      ev('t2', 'device.telemetry', 2),
      ev('t3', 'device.telemetry', 3),
      ev('p4', 'plan.changed', 4),
    ];
    const kept = coalesceEvents(events, { keepPerType: 2 });
    expect(kept.map((e) => e.sequence)).toEqual([2, 3, 4]);
  });

  it('自定义结构性前缀可配置', () => {
    const events = [
      ev('t1', 'device.telemetry', 1),
      ev('t2', 'device.telemetry', 2),
      ev('g3', 'gate.changed', 3),
    ];
    const kept = coalesceEvents(events, { structuralPrefixes: ['gate.'] });
    expect(kept.map((e) => e.sequence)).toEqual([2, 3]);
  });
});

describe('schedulerRealtimeCore.createEventBatcher（窗口批处理 + 结构性事件即时 flush）', () => {
  /** 手动触发的伪调度器（单测无需真实定时器）。 */
  function manualScheduler() {
    let scheduled: (() => void) | null = null;
    return {
      schedule: (fn: () => void) => {
        scheduled = fn;
        return { cancel: () => (scheduled = null) };
      },
      /** 手动触发一次已排定的 flush。 */
      fire: () => {
        const fn = scheduled;
        scheduled = null;
        fn?.();
      },
      hasPending: () => scheduled !== null,
    };
  }

  it('窗口内同类高频事件合并为一次 flush（store 写放大削减）', () => {
    const scheduler = manualScheduler();
    const batches: Array<EventBatch<TestEvent>> = [];
    const batcher = createEventBatcher<TestEvent>({
      windowMs: 100,
      onFlush: (batch) => batches.push(batch),
      schedule: scheduler.schedule,
    });
    for (let seq = 1; seq <= 20; seq += 1) {
      batcher.push(ev(`t${seq}`, 'device.telemetry', seq));
    }
    expect(batches).toHaveLength(0); // 窗口未到，不 flush
    scheduler.fire();
    expect(batches).toHaveLength(1); // 20 条遥测 → 1 次 flush
    expect(batches[0].rawCount).toBe(20);
    expect(batches[0].events).toHaveLength(1); // 只保留最新
    expect(batches[0].events[0].sequence).toBe(20);
    expect(batches[0].minSeq).toBe(1); // 缺口检测基准 = 窗口内最小 seq
    expect(batches[0].maxSeq).toBe(20); // 游标推进基准 = 窗口内最大 seq
  });

  it('结构性事件（plan.changed）立即 flush，不等窗口', () => {
    const scheduler = manualScheduler();
    const batches: Array<EventBatch<TestEvent>> = [];
    const batcher = createEventBatcher<TestEvent>({
      windowMs: 100,
      onFlush: (batch) => batches.push(batch),
      schedule: scheduler.schedule,
    });
    batcher.push(ev('t1', 'device.telemetry', 1));
    batcher.push(ev('p2', 'plan.changed', 2)); // 结构性 → 立即 flush
    // 先 flush 积压遥测（批次 1），再立即应用 plan.changed（批次 2），顺序保持。
    expect(batches).toHaveLength(2);
    expect(batches[0].events.map((e) => e.sequence)).toEqual([1]);
    expect(batches[1].events.map((e) => e.sequence)).toEqual([2]);
    expect(scheduler.hasPending()).toBe(false);
  });

  it('批次达到 maxBatchSize 立即 flush（防无限堆积）', () => {
    const scheduler = manualScheduler();
    const batches: Array<EventBatch<TestEvent>> = [];
    const batcher = createEventBatcher<TestEvent>({
      windowMs: 100,
      maxBatchSize: 8,
      onFlush: (batch) => batches.push(batch),
      schedule: scheduler.schedule,
    });
    for (let seq = 1; seq <= 20; seq += 1) {
      batcher.push(ev(`t${seq}`, 'device.telemetry', seq));
    }
    // 8 条触发一次 → 第 8、16 条立即 flush，余 4 条等窗口。
    expect(batches).toHaveLength(2);
    expect(batcher.pendingCount).toBe(4);
    scheduler.fire();
    expect(batches).toHaveLength(3);
  });

  it('flush() 手动冲刷积压；dispose() 丢弃积压且不再接受新事件', () => {
    const scheduler = manualScheduler();
    const batches: Array<EventBatch<TestEvent>> = [];
    const batcher = createEventBatcher<TestEvent>({
      windowMs: 100,
      onFlush: (batch) => batches.push(batch),
      schedule: scheduler.schedule,
    });
    batcher.push(ev('t1', 'device.telemetry', 1));
    expect(batcher.flush()).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batcher.flush()).toBe(false); // 无积压 → false

    batcher.push(ev('t2', 'device.telemetry', 2));
    batcher.dispose();
    expect(batcher.pendingCount).toBe(0);
    batcher.push(ev('t3', 'device.telemetry', 3)); // dispose 后丢弃
    expect(batcher.pendingCount).toBe(0);
    scheduler.fire();
    expect(batches).toHaveLength(1); // 未再 flush
  });

  it('windowMs=0 时事件在下一轮调度立即 flush（禁用批处理语义）', () => {
    const scheduler = manualScheduler();
    const batches: Array<EventBatch<TestEvent>> = [];
    const batcher = createEventBatcher<TestEvent>({
      windowMs: 0,
      onFlush: (batch) => batches.push(batch),
      schedule: scheduler.schedule,
    });
    batcher.push(ev('t1', 'device.telemetry', 1));
    expect(scheduler.hasPending()).toBe(true);
    scheduler.fire();
    expect(batches).toHaveLength(1);
  });
});
