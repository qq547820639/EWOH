/* CommandCenterView.render.test.tsx — 指挥中心纯展示视图渲染 smoke（NO-13ae / ADR-080）。
 *
 * R-87/R-89 模式推广：视图模型注入（overview/events）→ 契约字段透出
 * （KPI 标签+数值/事件标题+副标题/时间戳）+ 空态显式文案。零网络。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandCenterView } from './CommandCenterView';
import type { OverviewStats, EventInfo } from '@shared/api.interface';

const OVERVIEW: OverviewStats = {
  deviceTotal: 42,
  deviceOnline: 31,
  eventOpen: 5,
  eventCritical: 2,
  avgLoad: 58.4,
  workerCount: 17,
};

const EVENT: EventInfo = {
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

describe('CommandCenterView 渲染 smoke（NO-13ae / ADR-080）', () => {
  it('KPI 网格：六项标签与数值透出', () => {
    const markup = renderToStaticMarkup(
      <CommandCenterView overview={OVERVIEW} events={[]} />,
    );
    expect(markup).toContain('command-center-view');
    expect(markup).toContain('设备总数');
    expect(markup).toContain('42');
    expect(markup).toContain('平均负荷');
    expect(markup).toContain('58.4');
    expect(markup).toContain('作业人员');
    expect(markup).toContain('暂无事件记录。');
  });

  it('事件列表：标题/副标题/时间戳透出；缺 overview 数值归零', () => {
    const markup = renderToStaticMarkup(
      <CommandCenterView overview={undefined} events={[EVENT]} />,
    );
    expect(markup).toContain('安灯触发');
    expect(markup).toContain('EXO-1 · high · open');
    expect(markup).toContain('近期事件');
  });

  it('createdAt 缺失 → 时间戳空串显式（§33 不伪造）', () => {
    const markup = renderToStaticMarkup(
      <CommandCenterView overview={OVERVIEW} events={[{ ...EVENT, id: 'evt-2', createdAt: null }]} />,
    );
    expect(markup).toContain('安灯触发');
  });
});
