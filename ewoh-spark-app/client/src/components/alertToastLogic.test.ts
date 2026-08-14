// alertToastLogic.test.ts — L3 告警聚合纯函数测试。
import { aggregateL3 } from './alertToastLogic';
import type { EventInfo } from '@shared/api.interface';

const NOW = 1_800_000_000_000;

function ev(overrides: Partial<EventInfo>): EventInfo {
  return {
    id: 'e-1',
    eventId: 'EVT-1',
    deviceId: 'EXO-001',
    severity: 'L3',
    title: '告警',
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  } as EventInfo;
}

describe('aggregateL3', () => {
  it('同一设备多条 L3 聚合为一组（latest 最新）', () => {
    const events = [
      ev({ id: 'a', eventId: 'E-A', deviceId: 'EXO-001', createdAt: new Date(NOW - 5_000).toISOString() }),
      ev({ id: 'b', eventId: 'E-B', deviceId: 'EXO-001', createdAt: new Date(NOW - 2_000).toISOString() }),
      ev({ id: 'c', eventId: 'E-C', deviceId: 'EXO-002', createdAt: new Date(NOW - 1_000).toISOString() }),
    ];
    const agg = aggregateL3(events, NOW, 10_000);
    expect(agg).toHaveLength(2);
    // 最新在前
    expect(agg[0].deviceLabel).toBe('EXO-002');
    expect(agg[0].count).toBe(1);
    expect(agg[1].deviceLabel).toBe('EXO-001');
    expect(agg[1].count).toBe(2);
    expect(agg[1].latest.eventId).toBe('E-B');
  });

  it('窗口外/非 L3 事件被过滤', () => {
    const events = [
      ev({ id: 'a', eventId: 'E-A', severity: 'L2' }),
      ev({ id: 'b', eventId: 'E-B', createdAt: new Date(NOW - 60_000).toISOString() }),
      ev({ id: 'c', eventId: 'E-C', createdAt: null }),
    ];
    expect(aggregateL3(events, NOW, 10_000)).toEqual([]);
  });

  it('deviceId 缺失归入「未知设备」', () => {
    const events = [ev({ id: 'a', eventId: 'E-A', deviceId: null })];
    const agg = aggregateL3(events, NOW, 10_000);
    expect(agg).toHaveLength(1);
    expect(agg[0].deviceId).toBeNull();
    expect(agg[0].deviceLabel).toBe('未知设备');
  });

  it('undefined 输入安全返回空', () => {
    expect(aggregateL3(undefined, NOW, 10_000)).toEqual([]);
  });
});
