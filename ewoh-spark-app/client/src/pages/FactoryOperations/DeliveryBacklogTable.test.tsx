/**
 * DeliveryBacklogTable 渲染测试（NO-78a，零网络）。
 *
 * 契约：零积压不渲染表格（不伪造"需要处置"）；升级台数单列徽章；
 * 未交付/已投未回执分列；读失败显式报错。
 */
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => mockState,
}));

jest.mock('../../api/control', () => ({
  getDeliveryBacklogStatus: jest.fn(),
  getDeliveryBacklogHistory: jest.fn().mockResolvedValue({ slaMs: 300000, escalationMultiplier: 3, snapshots: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DeliveryBacklogTable } = require('./DeliveryBacklogTable');

const mockState: { data: unknown; isLoading: boolean; isError: boolean; error: unknown } = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
};

const SNAPSHOT = {
  slaMs: 300_000,
  escalationMultiplier: 3,
  totals: {
    devices: 2, commands: 5, undelivered: 3, receivedNotExecuted: 2,
    escalatedDevices: 1, oldestWaitingMs: 30 * 60_000,
  },
  devices: [
    { deviceId: 'AGV-A', commands: 3, undelivered: 2, receivedNotExecuted: 1, oldestWaitingMs: 30 * 60_000, escalated: true },
    { deviceId: 'AGV-B', commands: 2, undelivered: 1, receivedNotExecuted: 1, oldestWaitingMs: 6 * 60_000, escalated: false },
  ],
  checkedAt: '2026-09-16T12:00:00.000Z',
};

describe('DeliveryBacklogTable（NO-78a）', () => {
  beforeEach(() => {
    mockState.data = SNAPSHOT;
    mockState.isLoading = false;
    mockState.isError = false;
    mockState.error = null;
  });

  it('逐设备明细：设备/命令/未交付/已投未回执/最久等待/升级徽章', () => {
    const markup = renderToStaticMarkup(<DeliveryBacklogTable />);
    expect(markup).toContain('AGV-A');
    expect(markup).toContain('AGV-B');
    expect(markup).toContain('2 台 / 5 条');
    expect(markup).toContain('已升级 1 台');
    expect(markup).toContain('30 分钟');
    expect(markup).toContain('6 分钟');
  });

  it('升级行与跟踪行分列显示（不混为一谈）', () => {
    const markup = renderToStaticMarkup(<DeliveryBacklogTable />);
    expect(markup).toContain('已升级');
    expect(markup).toContain('巡检跟踪中');
  });

  it('零积压不渲染表格（不伪造"需要处置"）', () => {
    mockState.data = {
      ...SNAPSHOT,
      totals: { devices: 0, commands: 0, undelivered: 0, receivedNotExecuted: 0, escalatedDevices: 0, oldestWaitingMs: null },
      devices: [],
    };
    const markup = renderToStaticMarkup(<DeliveryBacklogTable />);
    expect(markup).toContain('当前没有投递积压');
    expect(markup).not.toContain('AGV-A');
  });

  it('读失败显式报错（不显示"一切正常"）', () => {
    mockState.data = undefined;
    mockState.isError = true;
    mockState.error = new Error('HTTP 403');
    const markup = renderToStaticMarkup(<DeliveryBacklogTable />);
    expect(markup).toContain('投递积压读取失败');
    expect(markup).toContain('HTTP 403');
  });

  it('加载中显式提示', () => {
    mockState.data = undefined;
    mockState.isLoading = true;
    const markup = renderToStaticMarkup(<DeliveryBacklogTable />);
    expect(markup).toContain('正在读取投递积压');
  });
});
