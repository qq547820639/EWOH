import {
  addTelemetrySink,
  getTelemetryEvents,
  installBatchedTelemetrySink,
  resetTelemetry,
  track,
} from './telemetry';
import type { TelemetryEvent } from './telemetry';

describe('telemetry（PRD §8 指标埋点）', () => {
  beforeEach(() => {
    resetTelemetry();
  });

  it('track 写入缓冲并带上时间戳与属性', () => {
    const event = track('object_workbench_view', { objectType: 'scheduling_plan' }, 1000);
    expect(event).toEqual({
      name: 'object_workbench_view',
      at: 1000,
      props: { objectType: 'scheduling_plan' },
    });
    expect(getTelemetryEvents()).toHaveLength(1);
  });

  it('at 缺省时取当前时间', () => {
    const before = Date.now();
    const event = track('nav_source', { source: 'sidebar' });
    expect(event.at).toBeGreaterThanOrEqual(before);
  });

  it('sink 收到事件', () => {
    const seen: string[] = [];
    addTelemetrySink((e) => seen.push(e.name));
    track('terminal_action_click', { action: 'viewExecution' });
    expect(seen).toEqual(['terminal_action_click']);
  });

  it('sink 抛错不影响缓冲与其他 sink（埋点不阻断业务）', () => {
    const seen: string[] = [];
    addTelemetrySink(() => {
      throw new Error('sink boom');
    });
    addTelemetrySink((e) => seen.push(e.name));
    expect(() => track('approval_deeplink_click')).not.toThrow();
    expect(seen).toEqual(['approval_deeplink_click']);
    expect(getTelemetryEvents()).toHaveLength(1);
  });

  it('注销后 sink 不再收到事件', () => {
    const seen: string[] = [];
    const off = addTelemetrySink((e) => seen.push(e.name));
    track('nav_source');
    off();
    track('nav_source');
    expect(seen).toHaveLength(1);
  });

  it('缓冲有上限，长时间运行不会无限增长', () => {
    for (let i = 0; i < 260; i += 1) track('nav_source', { i });
    const events = getTelemetryEvents();
    expect(events.length).toBeLessThanOrEqual(200);
    // 保留的是最近的事件。
    expect(events[events.length - 1].props.i).toBe(259);
  });

  it('getTelemetryEvents 返回副本，外部修改不影响内部缓冲', () => {
    track('nav_source');
    const copy = getTelemetryEvents();
    copy.length = 0;
    expect(getTelemetryEvents()).toHaveLength(1);
  });
});

describe('installBatchedTelemetrySink（J2 Gate G-1 批量上报）', () => {
  beforeEach(() => {
    resetTelemetry();
  });

  it('累积到 batchSize 时自动上报', () => {
    const batches: TelemetryEvent[][] = [];
    const dispose = installBatchedTelemetrySink(async (events) => {
      batches.push(events);
    }, { batchSize: 3, intervalMs: 60_000 });

    track('nav_source');
    track('nav_source');
    expect(batches).toHaveLength(0);
    track('nav_source');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    dispose();
  });

  it('上报失败静默吞掉，不影响业务', async () => {
    const dispose = installBatchedTelemetrySink(async () => {
      throw new Error('network down');
    }, { batchSize: 1 });
    expect(() => track('nav_source')).not.toThrow();
    await Promise.resolve();
    dispose();
  });

  it('卸载时冲刷剩余事件并停止收集', () => {
    const batches: TelemetryEvent[][] = [];
    const dispose = installBatchedTelemetrySink(async (events) => {
      batches.push(events);
    }, { batchSize: 100, intervalMs: 60_000 });

    track('nav_source');
    track('terminal_action_click');
    expect(batches).toHaveLength(0);

    dispose();
    // 卸载时冲刷剩余两条。
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    // 卸载后不再收集。
    track('nav_source');
    expect(batches).toHaveLength(1);
  });

  it('卸载后不再收集事件（sink 与定时器均已清理）', () => {
    const batches: TelemetryEvent[][] = [];
    const dispose = installBatchedTelemetrySink(async (events) => {
      batches.push(events);
    }, { batchSize: 100, intervalMs: 10 });

    track('nav_source');
    dispose(); // 冲刷 pending（1 条）
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);

    // 卸载后不再收集。
    track('nav_source');
    expect(batches).toHaveLength(1);
  });
});
