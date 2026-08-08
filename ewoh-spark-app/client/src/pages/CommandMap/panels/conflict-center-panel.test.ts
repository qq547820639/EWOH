/* v0.7 A3：ConflictCenterPanel 类型映射完整性测试
 * 验证前端 TYPE_META 覆盖后端全部 SchedulingConflictType（防展示漂移），
 * 以及冲突排序逻辑（高 → 中 → 低）。
 */
import type { SchedulingConflictType } from '@shared/api.interface';

// 从面板模块提取纯逻辑（避免渲染测试环境依赖）
import { TYPE_META, sortConflicts } from './conflict-panel-logic';

describe('v0.7 A3 ConflictCenterPanel 类型映射完整性', () => {
  const backendTypes: SchedulingConflictType[] = [
    'double_booking',
    'resource_stale',
    'person_unavailable',
    'device_offline',
    'low_battery',
    'predecessor_violation',
    'station_capacity',
    'forbidden_zone',
    'safety_block',
    'blocked_route',
    'stale_plan',
    'reservation_conflict',
    'reservation_expiring',
  ];

  it('TYPE_META 覆盖后端全部冲突类型（无展示漂移）', () => {
    for (const t of backendTypes) {
      expect(TYPE_META[t]).toBeDefined();
      expect(TYPE_META[t].label.length).toBeGreaterThan(0);
    }
  });

  it('TYPE_META 不含多余类型（键集与后端一致）', () => {
    const metaKeys = Object.keys(TYPE_META);
    expect(metaKeys.sort()).toEqual([...backendTypes].sort());
  });

  it('v0.7 新增 reservation_expiring 有映射', () => {
    expect(TYPE_META.reservation_expiring.label).toBe('预占即将过期');
  });
});

describe('v0.7 A3 冲突排序（高 → 中 → 低）', () => {
  const conflicts: Array<{ conflictId: string; type: SchedulingConflictType; severity: 'high' | 'medium' | 'low' }> = [
    { conflictId: 'c1', type: 'low_battery', severity: 'high' },
    { conflictId: 'c2', type: 'stale_plan', severity: 'low' },
    { conflictId: 'c3', type: 'blocked_route', severity: 'medium' },
    { conflictId: 'c4', type: 'double_booking', severity: 'high' },
  ];

  it('高严重度排前，同严重度保持原序', () => {
    const sorted = sortConflicts(conflicts);
    expect(sorted.map((c) => c.conflictId)).toEqual(['c1', 'c4', 'c3', 'c2']);
  });

  it('空列表安全返回', () => {
    expect(sortConflicts([])).toEqual([]);
  });
});
