/* Phase 3 / P3-T3：conflictVM 纯函数测试。 */
import {
  conflictVM,
  conflictActionsFor,
  conflictStatusLabel,
  conflictVmItemToConflict,
} from './conflictVM';
import type { SchedulingConflict } from '@shared/api.interface';

function conflict(over: Partial<SchedulingConflict>): SchedulingConflict {
  return {
    conflictId: 'CFL-1',
    type: 'device_offline',
    severity: 'high',
    scope: 'resource',
    resourceId: 'd1',
    resourceType: 'device',
    taskIds: [],
    message: '设备离线',
    resolution: null,
    createdAt: '2026-08-09T00:00:00.000Z',
    snapshotVersion: 'CURRENT',
    ...over,
  };
}

describe('conflictVM（冲突生命周期展示）', () => {
  it('按严重度排序（critical > high > medium > low）', () => {
    const vm = conflictVM([
      conflict({ conflictId: 'c-low', severity: 'low', status: 'OPEN' }),
      conflict({ conflictId: 'c-critical', severity: 'critical', status: 'OPEN' }),
      conflict({ conflictId: 'c-high', severity: 'high', status: 'OPEN' }),
    ]);
    expect(vm.items.map((i) => i.conflictId)).toEqual(['c-critical', 'c-high', 'c-low']);
    expect(vm.openCount).toBe(3);
    expect(vm.actionableCount).toBe(3);
  });

  it('状态分组 + 生命周期标签', () => {
    const vm = conflictVM([
      conflict({ conflictId: 'c-open', status: 'OPEN' }),
      conflict({ conflictId: 'c-ack', status: 'ACKNOWLEDGED', acknowledgedBy: 'op1' }),
      conflict({ conflictId: 'c-res', status: 'RESOLVED', resolvedBy: 'op2', resolution: 'auto_cleared' }),
      conflict({ conflictId: 'c-supp', status: 'SUPPRESSED', suppressUntil: '2026-08-10T00:00:00.000Z' }),
    ]);
    expect(vm.byStatus).toEqual({ OPEN: 1, ACKNOWLEDGED: 1, RESOLVED: 1, SUPPRESSED: 1 });
    expect(vm.actionableCount).toBe(2);
    expect(conflictStatusLabel('OPEN')).toBe('待处理');
    expect(conflictStatusLabel('SUPPRESSED')).toBe('已抑制');
  });

  it('状态机 actions：OPEN 可 ack/resolve/suppress；ACK 可 resolve/suppress；RESOLVED 无操作', () => {
    expect(conflictActionsFor('OPEN')).toEqual(['acknowledge', 'resolve', 'suppress']);
    expect(conflictActionsFor('ACKNOWLEDGED')).toEqual(['resolve', 'suppress']);
    expect(conflictActionsFor('RESOLVED')).toEqual([]);
  });

  it('suppressed 标记 + 空列表（不虚构）', () => {
    const vm = conflictVM([]);
    expect(vm.total).toBe(0);
    expect(vm.items).toEqual([]);
    const one = conflictVM([conflict({ status: 'SUPPRESSED' })]);
    expect(one.items[0].suppressed).toBe(true);
  });

  it('CLI-007：VM item 透传后端原始 createdAt，显式构造不伪造空串', () => {
    const vm = conflictVM([conflict({ createdAt: '2026-08-09T01:02:03.000Z' })]);
    expect(vm.items[0].createdAt).toBe('2026-08-09T01:02:03.000Z');
    const restored = conflictVmItemToConflict(vm.items[0]);
    expect(restored.createdAt).toBe('2026-08-09T01:02:03.000Z');
    expect(restored.conflictId).toBe('CFL-1');
    expect(restored.snapshotVersion).toBeNull();
  });
});
