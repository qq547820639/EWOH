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
    events: [{ eventId: 'e-1', severity: 'L3', title: '高温' }],
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

  it('advances to the next snapshot and wraps around', () => {
    expect(advanceReplayTime(snapshots, '2026-08-03T00:00:00.000Z')).toBe(
      '2026-08-03T00:01:00.000Z',
    );
    expect(advanceReplayTime(snapshots, '2026-08-03T00:02:00.000Z')).toBe(
      '2026-08-03T00:00:00.000Z',
    );
    expect(advanceReplayTime(snapshots, null)).toBe('2026-08-03T00:00:00.000Z');
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
