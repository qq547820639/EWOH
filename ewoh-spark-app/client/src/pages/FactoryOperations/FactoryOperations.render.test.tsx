import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import FactoryOperations from './FactoryOperations';

jest.mock('../../api/dashboard', () => ({
  getEventsPage: jest.fn(),
  getOverview: jest.fn(),
}));

jest.mock('../../api/scheduler', () => ({
  getActivePlans: jest.fn(),
}));

jest.mock('../../api/workbench', () => ({
  getWorkbenchNow: jest.fn().mockResolvedValue({ items: [], generatedAt: new Date().toISOString() }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}));

jest.mock('../../lib/auth', () => ({ getAuthUser: jest.fn() }));

const NOW = Date.parse('2026-09-10T01:00:00Z');
const OVERVIEW = { deviceTotal: 10, deviceOnline: 10, eventOpen: 0, eventCritical: 0, avgLoad: 0, workerCount: 0 };

type QueryState = {
  data?: unknown;
  dataUpdatedAt?: number;
  isLoading?: boolean;
  isError?: boolean;
  isFetching?: boolean;
};

function configureQueries(states: { overview?: QueryState; events?: QueryState; plans?: QueryState } = {}): void {
  (useQuery as jest.Mock).mockImplementation(({ queryKey }: { queryKey: readonly unknown[] }) => {
    const kind = queryKey[0] === 'scheduler-active-plans' ? 'plans' : queryKey[2] as 'overview' | 'events';
    return {
      data: undefined,
      dataUpdatedAt: 0,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
      ...states[kind],
    };
  });
}

function renderPage(): string {
  return renderToStaticMarkup(<MemoryRouter><FactoryOperations /></MemoryRouter>);
}

describe('FactoryOperations render', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    (getAuthUser as jest.Mock).mockReturnValue({ roles: ['global_admin'] });
    configureQueries();
  });

  afterEach(() => jest.restoreAllMocks());

  it('在没有后端数据时仍明确呈现产品主线和下一步', () => {
    const markup = renderPage();
    expect(markup).toContain('工厂运行台');
    expect(markup).toContain('今天的工厂，先处理什么？');
    expect(markup).toContain('暂不能确认待处理事项');
    expect(markup).not.toContain('当前没有待处理异常或调度审批。');
    expect(markup).toContain('— / —');
    expect(markup).toContain('生成调度方案');
    expect(markup).toContain('数据缺失会显式提示');
  });

  it.each([
    { isLoading: true },
    { isError: true },
    { data: [], dataUpdatedAt: NOW - 120_000, isError: true },
  ])('方案未完整取得时不输出空闲结论：%j', (plans) => {
    configureQueries({ events: { data: { items: [], total: 0 }, dataUpdatedAt: NOW }, plans });
    const markup = renderPage();
    expect(markup).toContain('暂不能确认待处理事项');
    expect(markup).not.toContain('当前已加载记录中没有');
    expect(markup).toContain(plans.isLoading ? '方案加载中' : '方案加载失败');
  });

  it('成功空态明确查询窗口和平台汇总来源限制', () => {
    configureQueries({
      overview: { data: OVERVIEW, dataUpdatedAt: NOW },
      events: { data: { items: [], total: 0 }, dataUpdatedAt: NOW },
      plans: { data: [], dataUpdatedAt: NOW },
    });
    const markup = renderPage();
    expect(markup).toContain('当前已加载记录中没有待处理异常或调度方案');
    expect(markup).toContain('近24小时最新8条');
    expect(markup).toContain('可能包含模拟、测试或历史数据');
    expect(markup).toContain('获取成功不代表现场实时或健康');
    expect(markup).not.toContain('当前没有待处理异常或调度审批。');
  });

  it('其他接口刷新成功不能掩盖旧指标或异常时间', () => {
    configureQueries({
      overview: { data: OVERVIEW, dataUpdatedAt: NOW - 120_000 },
      events: { data: { items: [], total: 0 }, dataUpdatedAt: NOW - 120_000 },
      plans: { data: [], dataUpdatedAt: NOW },
    });
    const markup = renderPage();
    expect(markup).toContain('暂不能确认待处理事项');
    expect(markup.match(/时间异常或已超过60秒，请刷新/g)).toHaveLength(2);
    expect(markup).not.toContain('bg-risk-normal-soft');
  });

  it('安全员只看到其角色真正有权访问的入口（调度/仿真/决策历史不出现）', () => {
    (getAuthUser as jest.Mock).mockReturnValue({ roles: ['safety_admin'] });
    const markup = renderPage();
    expect(markup).toContain('href="/command-map"');
    expect(markup).toContain('请联系授权调度人员');
    for (const path of ['/scheduling', '/simulation', '/decision-history']) {
      expect(markup).not.toContain(`href="${path}"`);
    }
    // FE-2：审批控制台对 safety_admin 是后端放行（GET /api/approvals/pending 的
    // @Roles 含 safety_admin），前端导航此前漏登记；现按后端为权威放开入口。
    expect(markup).toContain('href="/approval-console"');
  });

  it('使用调度共享缓存并保留待派工方案编号', () => {
    configureQueries({
      plans: { data: [{ planId: 'plan/1', status: 'approved', planName: '离线应急重排', metrics: { lateMinutes: 18 }, snapshotVersion: '12' }], dataUpdatedAt: NOW },
    });
    const markup = renderPage();
    expect(markup).toContain('href="/o/scheduling_plan/plan%2F1"');
    expect(markup).toContain('已审批，待派工');
    expect(markup).toContain('查看方案并派工');
    expect(useQuery).toHaveBeenCalledWith(expect.objectContaining({ queryKey: queryKeys.schedulerActivePlans }));
  });
});
