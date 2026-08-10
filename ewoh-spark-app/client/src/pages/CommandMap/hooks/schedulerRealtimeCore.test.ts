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
    expect(keys).toContainEqual(['scheduler-active-plans']);
    expect(keys).toContainEqual(['scheduler', 'snapshot']);
    expect(keys).toContainEqual(['scheduler-resource-state']);
    expect(keys).toContainEqual(['scheduler', 'conflicts', {}]);
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
