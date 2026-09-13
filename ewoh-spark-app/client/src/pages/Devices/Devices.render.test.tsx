/* Devices 渲染 smoke（FE-1，原则 7：缺失/不可信数据不得被静默伪造成确定事实）。
 *
 * 已核实的两处：
 *  1) 责任关系查询读失败 → 责任关系表退化为空 → 每台设备都被判成"未登记责任人"，
 *     页头于是伪造出「未登记责任人的设备 N 台」（真相是"没读到"）；
 *  2) 人员名单查询读失败 → 姓名静默为空/退化为人员 ID，页面不做任何说明。
 *
 * 不变量：**查询失败时绝不出现「没有数据」类文案**（这里表现为伪造的业务结论）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_: unknown, key: string) => {
        const Icon = (props: Record<string, unknown>) =>
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('react').createElement('span', { 'data-icon': key, ...props });
        Icon.displayName = key;
        return Icon;
      },
    },
  ),
);

// recharts 在 node 下无可测量容器；渲染 smoke 只关心文案，用空壳替换。
jest.mock('recharts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  const Shell = ({ children }: { children?: unknown }) => React.createElement('div', null, children);
  const Empty = () => null;
  return {
    BarChart: Shell,
    Bar: Shell,
    ResponsiveContainer: Shell,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    Cell: Empty,
  };
});

interface MockQueryState {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const mockQueries: Record<string, MockQueryState> = {};

const ok = (data?: unknown): MockQueryState => ({ data, isLoading: false, isError: false, error: null });

function mockStateFor(key: string): MockQueryState {
  return mockQueries[key] ?? ok([]);
}

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = (options.queryKey ?? []).join('|');
    const state = mockStateFor(key);
    return { ...state, isFetching: false, dataUpdatedAt: 0, refetch: jest.fn() };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../hooks/queryKeys', () => ({
  queryKeys: {
    devices: () => ['devices'],
    spatialEntities: ['spatialEntities'],
  },
}));

jest.mock('../../api/dashboard', () => ({ searchDevices: jest.fn() }));
jest.mock('../../api/spatial', () => ({ getEntities: jest.fn() }));
jest.mock('../../api/deviceResponsibility', () => ({ listDeviceResponsibilities: jest.fn() }));
jest.mock('../../api/organization', () => ({ listPersonnel: jest.fn() }));

// 同目录重型对话框与 api 依赖无关，剥掉以免把无关模块拖进 node 环境。
jest.mock('./DeviceConfigDrawer', () => ({ __esModule: true, default: () => null }));
jest.mock('./BatchCapabilityRestoreDialog', () => ({ BatchCapabilityRestoreDialog: () => null }));
jest.mock('./ResponsibilityDialog', () => ({ __esModule: true, default: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Devices = require('./Devices').default;

const FORBIDDEN = {
  response: { status: 403, data: { error: { code: 'PERMISSION_DENIED', message: 'Forbidden' } } },
};

const DEVICE = {
  id: 'd1',
  deviceId: 'EXO-1',
  deviceModel: 'X1',
  deviceCategory: 'exoskeleton',
  sourceType: 'real',
  status: 'online',
  online: true,
  batteryPct: 80,
  parentId: null,
  boundPersonName: null,
  workerName: null,
  lastTelemetryAt: null,
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
  );
}

describe('Devices 渲染（FE-1 次级查询失败不得渲染成业务空态）', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockQueries)) delete mockQueries[key];
    mockQueries['devices'] = ok([DEVICE]);
    mockQueries['spatialEntities'] = ok([]);
    mockQueries['device-responsibilities|page'] = ok([]);
    mockQueries['devices|personnel'] = ok([{ personId: 'p1', name: '张三' }]);
  });

  it('责任关系 403：不伪造「未登记责任人的设备 N 台」，改为说明读不到', () => {
    mockQueries['device-responsibilities|page'] = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: FORBIDDEN,
    };
    const markup = render();
    expect(markup).not.toContain('未登记责任人的设备 1 台');
    expect(markup).not.toContain('当前列表的设备都已登记责任人');
    expect(markup).toContain('责任人数据读取失败');
  });

  it('责任关系成功且为空：仍显示「未登记责任人的设备 N 台」（真无数据才这么说）', () => {
    const markup = render();
    expect(markup).toContain('未登记责任人的设备 1 台');
    expect(markup).not.toContain('责任人数据读取失败');
  });

  it('人员名单 403：显式说明责任人只能显示人员 ID（姓名静默为空被禁止）', () => {
    mockQueries['devices|personnel'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).toContain('device-personnel-error');
    expect(markup).toContain('人员名单读取失败');
  });

  it('设备查询 403：电量分布面板不显示「暂无数据」（读失败 ≠ 没有数据）', () => {
    mockQueries['devices'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).toContain('device-battery-error');
    expect(markup).not.toContain('暂无数据');
    // 责任人汇总也不得宣称"都已登记"（列表根本没读出来）
    expect(markup).not.toContain('当前列表的设备都已登记责任人');
    expect(markup).toContain('设备列表读取失败：无法核对责任人登记情况');
    // 设备列表区域仍然走 AppErrorState（既有行为不变：403 → 权限不足）
    expect(markup).toContain('权限不足');
  });

  it('人员名单成功：不出现人员读取失败提示，且责任关系能解析出姓名', () => {
    mockQueries['device-responsibilities|page'] = ok([
      { deviceId: 'EXO-1', personId: 'person:p1', responsibility: 'owner', active: true, shiftId: '' },
    ]);
    const markup = render();
    expect(markup).not.toContain('人员名单读取失败');
    expect(markup).toContain('张三');
  });
});
