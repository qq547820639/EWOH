import {
  comparePriority,
  isOverdue,
  priorityColumnKey,
  priorityLabel,
  priorityOrder,
  prioritySortRows,
  summarizeItem,
  triageRoleItems,
} from './priorityTriage';

const NOW = new Date('2026-08-05T12:00:00Z').getTime();

describe('priorityTriage (UX-001 待处理事项优先)', () => {
  it('maps priority levels to中文标签 and stable ordering', () => {
    expect(priorityLabel('critical')).toBe('紧急');
    expect(priorityLabel('high')).toBe('高');
    expect(priorityLabel('medium')).toBe('中');
    expect(priorityLabel('low')).toBe('低');
    expect(priorityOrder('critical')).toBeLessThan(priorityOrder('high'));
    expect(priorityOrder('high')).toBeLessThan(priorityOrder('medium'));
    expect(comparePriority('critical', 'low')).toBeLessThan(0);
    expect(comparePriority('low', 'high')).toBeGreaterThan(0);
  });

  it('flags overdue deadlines', () => {
    expect(isOverdue('2026-08-05T11:00:00Z', NOW)).toBe(true);
    expect(isOverdue('2026-08-05T13:00:00Z', NOW)).toBe(false);
    expect(isOverdue(undefined, NOW)).toBe(false);
    expect(isOverdue('not-a-date', NOW)).toBe(false);
  });

  it('sorts items critical-first, then by earliest deadline within same priority', () => {
    const result = triageRoleItems(
      'manager',
      [
        {
          id: 'a',
          title: '低优先级',
          reason: 'r',
          priority: 'low',
        },
        {
          id: 'b',
          title: '紧急且更早',
          reason: 'r',
          priority: 'critical',
          deadline: '2026-08-05T10:00:00Z',
        },
        {
          id: 'c',
          title: '紧急较晚',
          reason: 'r',
          priority: 'critical',
          deadline: '2026-08-05T14:00:00Z',
        },
        {
          id: 'd',
          title: '高优先级',
          reason: 'r',
          priority: 'high',
        },
      ],
      NOW,
    );
    expect(result.map((item) => item.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(result[0].priorityLabel).toBe('紧急');
    expect(result[0].overdue).toBe(true);
    expect(result[3].overdue).toBe(false);
  });

  it('does not mutate the input array', () => {
    const input = [{ id: 'x', title: 't', reason: 'r', priority: 'low' as const }];
    triageRoleItems('operator', input);
    expect(input).toHaveLength(1);
  });

  it('identifies a priority column by common keys', () => {
    expect(priorityColumnKey([{ key: 'name' }, { key: 'priority' }])).toBe('priority');
    expect(priorityColumnKey([{ key: 'severity' }])).toBe('severity');
    expect(priorityColumnKey([{ key: 'name' }])).toBeNull();
  });

  it('sorts generic table rows by priority as a default sort', () => {
    const rows = [
      { name: '低', priority: 'low' },
      { name: '紧急', priority: 'critical' },
      { name: '高', priority: 'HIGH' },
    ];
    const sorted = prioritySortRows(rows, [{ key: 'name' }, { key: 'priority' }]);
    expect(sorted[0].name).toBe('紧急');
    expect(sorted[1].name).toBe('高');
    expect(sorted[2].name).toBe('低');
  });

  it('returns rows unchanged when no priority column exists', () => {
    const rows = [{ name: 'a' }, { name: 'b' }];
    expect(prioritySortRows(rows, [{ key: 'name' }])).toEqual(rows);
  });

  it('summarizes why-now / deadline / impact / owner / next-step (spec item 11)', () => {
    const [item] = triageRoleItems(
      'operator',
      [
        {
          id: 's1',
          title: '装配异常',
          reason: '设备故障影响产能',
          priority: 'high',
          deadline: '2026-08-05T11:00:00Z',
          impact: '该线产能下降 30%',
          owner: '张工',
          nextStep: '切换备用工位',
        },
      ],
      NOW,
    );
    const summary = summarizeItem(item, NOW);
    expect(summary.reason).toContain('设备故障影响产能');
    expect(summary.reason).toContain('已逾期');
    expect(summary.impact).toBe('该线产能下降 30%');
    expect(summary.owner).toBe('张工');
    expect(summary.nextStep).toBe('切换备用工位');
    expect(summary.deadline).not.toBe('');
  });

  it('summarizes an item without deadline or owner gracefully', () => {
    const [item] = triageRoleItems(
      'operator',
      [{ id: 's2', title: '待检', reason: '', priority: 'low' }],
      NOW,
    );
    const summary = summarizeItem(item, NOW);
    expect(summary.reason).toBe('待处理事项');
    expect(summary.deadline).toBe('');
    expect(summary.owner).toBe('');
    expect(summary.nextStep).toBe('');
  });
});