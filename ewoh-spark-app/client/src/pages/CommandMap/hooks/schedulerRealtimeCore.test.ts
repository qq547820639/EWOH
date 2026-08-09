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
} from './schedulerRealtimeCore';

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
