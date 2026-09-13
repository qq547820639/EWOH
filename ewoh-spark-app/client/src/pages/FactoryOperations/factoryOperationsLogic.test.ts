import type { EventInfo, OverviewStats } from '@shared/api.interface';
import type { SchedulingPlanV2 } from '@shared/scheduler';
import { buildAttentionItems, buildFactoryOperationsKpis, formatFreshness, isFactoryDataCurrent } from './factoryOperationsLogic';

const OVERVIEW: OverviewStats = {
  deviceTotal: 10,
  deviceOnline: 8,
  eventOpen: 2,
  eventCritical: 1,
  avgLoad: 0.67,
  workerCount: 6,
};

const EVENT: EventInfo = {
  id: 'event-1',
  eventId: 'event-1',
  deviceId: 'machine-1',
  eventCode: 'DEVICE_OFFLINE',
  eventType: 'device',
  severity: 'high',
  title: '设备离线',
  status: 'open',
  createdAt: '2026-09-10T00:00:00.000Z',
  handlerAction: null,
};

const PLAN = {
  planId: 'plan-1',
  planName: '设备离线应急重排',
  version: 1,
  status: 'draft',
  trigger: { type: 'DEVICE_OFFLINE', entityId: 'machine-1' },
  snapshotVersion: '12',
  policyVersion: 1,
  solverVersion: 'heuristic-v1',
  horizonMinutes: 120,
  assignments: [],
  metrics: {
    lateMinutes: 18,
    walkingMeters: 40,
    stationWaitMinutes: 2,
    maxWorkload: 0.75,
    changeCost: 1,
  },
  baselineDelta: {},
  violations: [],
  createdAt: '2026-09-10T00:00:00.000Z',
} as unknown as SchedulingPlanV2;

describe('factoryOperationsLogic', () => {
  it('把实时指标转成用户能判断的状态', () => {
    const kpis = buildFactoryOperationsKpis(OVERVIEW);
    expect(kpis.map((item) => item.label)).toEqual([
      '中高风险记录',
      '待确认事件',
      '在线设备',
      '近1小时平均负荷',
      '绑定人员',
    ]);
    expect(kpis[0]).toMatchObject({ value: '1', tone: 'critical' });
    expect(kpis[2]).toMatchObject({ value: '8 / 10', tone: 'warning' });
    expect(kpis[3]).toMatchObject({ value: '67%', tone: 'neutral' });
  });

  it('把现场事件和待审批方案合并为下一步动作', () => {
    const items = buildAttentionItems([EVENT], [PLAN]);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(['event', 'plan']);
    expect(items[0]).toMatchObject({ href: '/o/alert/event-1', tone: 'critical', detail: expect.stringContaining('待确认') });
    expect(items[1]).toMatchObject({ href: '/o/scheduling_plan/plan-1', detail: expect.stringContaining('18'), actionLabel: '查看影响与审批' });
  });

  it('系统审计事件不冒充现场异常：单独分组、不占异常名额', () => {
    const systemEvents = [
      { ...EVENT, id: 'evt-sys-1', eventId: 'EVT-ANNOT', eventType: 'OutcomeAnnotationRecorded', title: 'OutcomeAnnotationRecorded: plan P1' },
      { ...EVENT, id: 'evt-sys-2', eventId: 'EVT-SIM', eventType: 'SimulationRunCompleted', title: 'SimulationRunCompleted: layout x' },
    ] as unknown as EventInfo[];
    const items = buildAttentionItems(systemEvents, [PLAN]);
    // 异常槽位为空时系统记录也不应变成"现场异常"，plan 正常保留。
    expect(items.map((item) => item.kind)).toEqual(['plan', 'system', 'system']);
    expect(items[1]).toMatchObject({ tone: 'neutral', detail: expect.stringContaining('非现场异常'), actionLabel: '查看台账详情' });
    // 显式 sourceType=learning（无 eventType 特征）同样按系统记录分组。
    const bySource = buildAttentionItems(
      [{ ...EVENT, id: 'evt-sys-3', eventId: 'EVT-LEARN', eventType: 'custom', sourceType: 'learning' } as unknown as EventInfo],
      [],
    );
    expect(bySource.map((item) => item.kind)).toEqual(['system']);
    // 系统记录排在实际现场异常之后，不抢占注意力。
    const mixed = buildAttentionItems(
      [...systemEvents, EVENT] as unknown as EventInfo[],
      [],
    );
    expect(mixed[0]).toMatchObject({ kind: 'event', href: '/o/alert/event-1' });
    expect(mixed.filter((item) => item.kind === 'system')).toHaveLength(2);
  });

  it('影子方案保留对象上下文并明确尚未授权执行', () => {
    const shadowPlan = { ...PLAN, status: 'shadow' } as unknown as SchedulingPlanV2;
    expect(buildAttentionItems([], [shadowPlan])[0]).toMatchObject({
      href: '/o/scheduling_plan/plan-1',
      tone: 'neutral',
      detail: expect.stringContaining('尚未授权执行'),
      actionLabel: '查看影子方案与评估证据',
    });
  });

  it('未知指标不能伪装成零或健康状态', () => {
    const kpis = buildFactoryOperationsKpis(undefined);
    expect(kpis.map((item) => item.value)).toEqual(['—', '—', '— / —', '—', '—']);
    expect(kpis.every((item) => item.tone === 'neutral')).toBe(true);
    expect(buildFactoryOperationsKpis({ ...OVERVIEW, avgLoad: Number.NaN })[3].value).toBe('—');
  });

  it('无设备和过期快照不显示健康色', () => {
    expect(buildFactoryOperationsKpis({ ...OVERVIEW, deviceOnline: 0, deviceTotal: 0 })[2].tone).toBe('neutral');
    expect(buildFactoryOperationsKpis(OVERVIEW, false).every((item) => item.tone === 'neutral')).toBe(true);
  });

  it('标记模拟和缺失来源，不把方案预测写成执行结果', () => {
    const items = buildAttentionItems([{ ...EVENT, sourceType: 'simulated' }], [PLAN]);
    expect(items[0].detail).toContain('模拟数据');
    expect(buildAttentionItems([EVENT], [])[0].detail).toContain('来源未提供，待核验');
    expect(items[1].detail).toContain('非现场执行结果');
  });

  it('按风险显示异常并为待派工方案保留位置', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...EVENT, eventId: `event-${index}`, severity: index === 7 ? 'critical' : 'low',
    }));
    const approved = { ...PLAN, planId: 'approved', status: 'approved' } as SchedulingPlanV2;
    const items = buildAttentionItems(events, [PLAN, approved]);
    expect(items[0].id).toBe('event:event-7');
    expect(items.filter((item) => item.kind === 'event')).toHaveLength(4);
    expect(items[4]).toMatchObject({ id: 'plan:approved', actionLabel: '查看方案并派工' });
  });

  it('保留已派工和执行中方案，排除已关闭异常和终态方案', () => {
    const plans = ['approved', 'dispatched', 'executing', 'rejected', 'completed', 'superseded'].map(
      (status) => ({ ...PLAN, planId: status, status }) as SchedulingPlanV2,
    );
    const items = buildAttentionItems([{ ...EVENT, status: 'closed' }], plans);
    expect(items.map((item) => item.id)).toEqual(['plan:approved', 'plan:dispatched', 'plan:executing']);
    expect(items[1].actionLabel).toBe('查看方案与执行入口');
  });

  it('对象链接编码特殊字符', () => {
    const items = buildAttentionItems([{ ...EVENT, eventId: 'event/1#evidence' }], [{ ...PLAN, planId: 'plan/1?a=b' }]);
    expect(items[0].href).toBe('/o/alert/event%2F1%23evidence');
    expect(items[1].href).toBe('/o/scheduling_plan/plan%2F1%3Fa%3Db');
  });

  it('缺失更新时间时明确说明没有取得平台数据', () => {
    expect(formatFreshness(undefined)).toBe('尚未取得平台数据');
    expect(formatFreshness(Number.NaN)).toBe('尚未取得平台数据');
  });

  it('获取时间包括日期，过期和未来时间不表示现场实时', () => {
    const now = Date.parse('2026-09-10T01:00:00Z');
    expect(isFactoryDataCurrent(now - 59_999, now)).toBe(true);
    expect(isFactoryDataCurrent(now - 60_000, now)).toBe(false);
    expect(isFactoryDataCurrent(now + 1, now)).toBe(false);
    expect(formatFreshness(now - 60_000, now)).toContain('请刷新');
    expect(formatFreshness(now, now)).toContain('2026');
    expect(formatFreshness(now, now)).toContain('最近获取于');
    expect(formatFreshness(now, now)).not.toContain('请刷新');
  });
});
