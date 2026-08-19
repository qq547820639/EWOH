import type { CurrentWorldState, ReplaySnapshot } from '@shared/api.interface';
import {
  advanceReplayTime,
  findNearestSnapshot,
  snapshotToWorldState,
} from './replay';

const snapshots: ReplaySnapshot[] = [
  {
    ts: '2026-08-03T00:00:00.000Z',
    persons: [],
    devices: [],
    events: [],
  },
  {
    ts: '2026-08-03T00:01:00.000Z',
    persons: [{ entityId: 'p1', x: 10, y: 20, status: 'active' }],
    devices: [],
    events: [{ eventId: 'e-1', severity: 'critical', title: '高温' }],
  },
  {
    ts: '2026-08-03T00:02:00.000Z',
    persons: [],
    devices: [{ entityId: 'd1', x: 30, y: 40, status: 'online' }],
    events: [],
  },
];

describe('replay helpers', () => {
  it('finds the nearest snapshot by timestamp', () => {
    expect(findNearestSnapshot(snapshots, '2026-08-03T00:01:30.000Z')?.ts).toBe(
      '2026-08-03T00:01:00.000Z',
    );
    expect(findNearestSnapshot([], '2026-08-03T00:00:00.000Z')).toBeNull();
  });

  it('CLI-730：covers out-of-range and single-element snapshots', () => {
    // 目标时间早于全部快照 → 最近的仍是第一张。
    expect(findNearestSnapshot(snapshots, '2026-08-02T23:00:00.000Z')?.ts).toBe(
      '2026-08-03T00:00:00.000Z',
    );
    // 目标时间晚于全部快照 → 最近的仍是最后一张。
    expect(findNearestSnapshot(snapshots, '2026-08-03T12:00:00.000Z')?.ts).toBe(
      '2026-08-03T00:02:00.000Z',
    );
    // 单元素快照：任何目标时间都命中唯一一张。
    const single: ReplaySnapshot[] = [snapshots[1]];
    expect(findNearestSnapshot(single, '2026-08-03T00:00:30.000Z')?.ts).toBe(
      '2026-08-03T00:01:00.000Z',
    );
    expect(findNearestSnapshot(single, '2026-08-03T00:01:00.000Z')?.ts).toBe(
      '2026-08-03T00:01:00.000Z',
    );
  });

  it('advances to the next snapshot and wraps around', () => {
    expect(advanceReplayTime(snapshots, '2026-08-03T00:00:00.000Z')).toBe(
      '2026-08-03T00:01:00.000Z',
    );
    expect(advanceReplayTime(snapshots, '2026-08-03T00:02:00.000Z')).toBe(
      '2026-08-03T00:00:00.000Z',
    );
    expect(advanceReplayTime(snapshots, null)).toBe('2026-08-03T00:00:00.000Z');
  });

  it('2026-08-20 回放卡死修复：倒序快照（服务端实际返回顺序）也能连续推进', () => {
    // 服务端 /api/world/replay 返回倒序（最新在前）。原实现在倒序输入下
    // 从 [0]（最新帧）起找不到更晚快照 → 时间指针卡死 = 「回放自动暂停」。
    const reversed = [...snapshots].reverse();
    // 起点取最旧帧（而非数组 [0] 的最新帧）。
    expect(advanceReplayTime(reversed, null)).toBe('2026-08-03T00:00:00.000Z');
    // 从最旧帧连续推进到下一帧。
    expect(advanceReplayTime(reversed, '2026-08-03T00:00:00.000Z')).toBe(
      '2026-08-03T00:01:00.000Z',
    );
    // 最新帧后循环回最旧（连续播放不卡死）。
    expect(advanceReplayTime(reversed, '2026-08-03T00:02:00.000Z')).toBe(
      '2026-08-03T00:00:00.000Z',
    );
  });

  it('projects a replay snapshot into a renderable world state', () => {
    const base: CurrentWorldState = {
      ts: '2026-08-03T00:03:00.000Z',
      persons: [{ entityId: 'p1', name: '张三', x: 0, y: 0, status: 'idle', confidence: 1 }],
      devices: [{ entityId: 'd1', name: 'EXO-1', x: 0, y: 0, status: 'online' }],
      workstations: [{ entityId: 'w1', name: '工位1', x: 0, y: 0, status: 'idle', occupancy: 0.2 }],
      events: [],
    };
    const state = snapshotToWorldState(snapshots[1], base);
    expect(state.persons[0].name).toBe('张三');
    expect(state.ts).toBe('2026-08-03T00:01:00.000Z');
    expect(state.events[0].title).toBe('高温');
    expect(state.workstations).toHaveLength(1);
  });
});
