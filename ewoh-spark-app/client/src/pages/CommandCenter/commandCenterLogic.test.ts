/* commandCenterLogic.test.ts — 指挥中心纯逻辑（NO-13ae / ADR-080，§17/§33）。 */
import {
  buildCommandCenterKpis,
  buildEventSubtitle,
  formatEventTimestamp,
} from './commandCenterLogic';
import type { OverviewStats, EventInfo } from '@shared/api.interface';

const OVERVIEW: OverviewStats = {
  deviceTotal: 42,
  deviceOnline: 31,
  eventOpen: 5,
  eventCritical: 2,
  avgLoad: 58.4,
  workerCount: 17,
};

describe('commandCenterLogic（NO-13ae / ADR-080）', () => {
  it('KPI 派生：六项真实值透出（设备/事件/负荷/人员）', () => {
    const kpis = buildCommandCenterKpis(OVERVIEW);
    expect(kpis).toHaveLength(6);
    expect(kpis.map((k) => k.label)).toEqual([
      '设备总数',
      '在线设备',
      '未关闭事件',
      '重大事件',
      '平均负荷',
      '作业人员',
    ]);
    expect(kpis.find((k) => k.key === 'deviceTotal')?.value).toBe(42);
    expect(kpis.find((k) => k.key === 'avgLoad')?.value).toBe(58.4);
  });

  it('overview 缺失 → 全部 0（显式缺省，不猜）', () => {
    const kpis = buildCommandCenterKpis(undefined);
    expect(kpis.every((k) => k.value === 0)).toBe(true);
  });

  it('事件副标题：设备 · 严重度 · 状态（原始事实透出）', () => {
    const event: EventInfo = {
      id: 'evt-1',
      eventId: 'EVT-1',
      deviceId: 'EXO-1',
      eventCode: 'ANDON',
      eventType: 'andon',
      severity: 'high',
      title: '安灯触发',
      status: 'open',
      createdAt: '2026-08-16T08:00:00.000Z',
      handlerAction: null,
    };
    expect(buildEventSubtitle(event)).toBe('EXO-1 · high · open');
  });

  it('时间格式化：有效 ISO → 本地化串；缺失 → 空串（§33 不伪造）', () => {
    expect(formatEventTimestamp('2026-08-16T08:00:00.000Z')).not.toBe('');
    expect(formatEventTimestamp(null)).toBe('');
    expect(formatEventTimestamp(undefined)).toBe('');
  });
});
