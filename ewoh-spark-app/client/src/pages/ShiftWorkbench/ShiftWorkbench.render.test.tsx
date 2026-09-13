/* ShiftWorkbench 渲染 smoke（FE-1，原则 7：缺失/不可信数据不得被静默伪造成确定事实）。
 *
 * 场景（已核实）：/shift-workbench 对 safety_admin 开放，而
 * /api/scheduler/active-plans、/api/scheduler/executions 的控制器角色集是
 * ['global_admin','dispatcher','workshop_lead']（server/modules/scheduler + route-role.policy.ts）
 * → safety_admin 必得 403。旧写法只判 !isLoading：方案列表渲染「当前无待审批/执行中方案」，
 * 两个 KPI（待审批方案 / 执行偏差）显示 0 且配"无积压 / 暂无偏差记录"——
 * 把"没权限读"说成"没有待批、没有偏差"。
 *
 * 不变量：**查询失败时绝不出现「没有数据」类文案**。
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

interface MockQueryState {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const mockQueries: Record<string, MockQueryState> = {};
/** 按声明顺序捕获 useMutation 的 options（dqMutation 是第一个）。 */
const mockMutationCalls: Array<Record<string, unknown>> = [];
const mockInvalidate = jest.fn();

const ok = (data?: unknown): MockQueryState => ({ data, isLoading: false, isError: false, error: null });

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options.queryKey ?? [];
    // 租户分片键首段是 org（'org-under-test'），业务段在第二位。
    const lookup = key[0] === 'org-under-test' ? key[1] : key[0];
    const state = mockQueries[lookup as string] ?? ok(undefined);
    return { ...state, isFetching: false, dataUpdatedAt: 0, refetch: jest.fn() };
  },
  useMutation: (options: Record<string, unknown>) => {
    mockMutationCalls.push(options);
    return { mutate: jest.fn(), isPending: false, isError: false, error: null };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

jest.mock('../../hooks/queryKeys', () => ({
  // 与真实 queryKeys 同构：tenantQueryKey 以 org 分片开头，dataQualityConfirmations
  // 挂在其下——这样才能验证"失效键是否前缀匹配查询键"。
  tenantQueryKey: (...segments: unknown[]) => ['org-under-test', ...segments],
  queryKeys: new Proxy(
    {},
    {
      get: (_target: unknown, prop: string) => {
        if (prop === 'dataQualityConfirmations') {
          return (eventIds: readonly string[]) =>
            ['org-under-test', 'data-quality-confirmations', [...eventIds].sort()];
        }
        if (
          prop === 'schedulerExecutions'
          || prop === 'factoryOperationsEvents'
        ) {
          return (...args: unknown[]) => [prop, ...args];
        }
        return [prop];
      },
    },
  ),
}));

jest.mock('../../api/dashboard', () => ({
  getEventsPage: jest.fn(),
  getOverview: jest.fn(),
  getPlannedVsActual: jest.fn(),
}));
jest.mock('../../api/scheduler', () => ({ getActivePlans: jest.fn(), listExecutions: jest.fn() }));
jest.mock('../../api/shift', () => ({
  createHandover: jest.fn(),
  getCurrentShift: jest.fn(),
  listHandovers: jest.fn(),
  listShifts: jest.fn(),
  upsertShift: jest.fn(),
}));
jest.mock('../../api/dataQuality', () => ({
  confirmDataQuality: jest.fn(),
  getDataQualityConfirmations: jest.fn(),
}));
jest.mock('../../api/approvals', () => ({ listNotifications: jest.fn() }));
jest.mock('../../api/perception', () => ({
  listPerceptionFusion: jest.fn(),
  sweepPerceptionFusion: jest.fn(),
}));
jest.mock('../../api/deviceResponsibility', () => ({ getResponsibilityCoverage: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ShiftWorkbench = require('./ShiftWorkbench').default;

const FORBIDDEN = {
  response: { status: 403, data: { error: { code: 'PERMISSION_DENIED', message: 'Forbidden' } } },
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ShiftWorkbench />
    </MemoryRouter>,
  );
}

describe('ShiftWorkbench 渲染（FE-1 次级查询失败不得渲染成业务空态）', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockQueries)) delete mockQueries[key];
    mockMutationCalls.length = 0;
    mockInvalidate.mockClear();
    mockQueries.shiftCurrent = ok({
      current: { shiftId: 'S1', name: '早班', startTime: '08:00', endTime: '16:00', crossesMidnight: false },
      next: null,
    });
    mockQueries.shiftDefinitions = ok([
      { shiftId: 'S1', name: '早班', startTime: '08:00', endTime: '16:00', crossesMidnight: false },
    ]);
    mockQueries.shiftHandovers = ok([]);
    mockQueries.factoryOperationsEvents = ok({ items: [], total: 0 });
    mockQueries.factoryOperationsOverview = ok({ materials: [] });
    mockQueries.schedulerActivePlans = ok([]);
    mockQueries.schedulerExecutions = ok({ executions: [] });
    mockQueries.dataQualityConfirmations = ok([]);
    mockQueries.notificationsPending = ok([]);
    mockQueries['perception'] = ok([]);
    mockQueries['scheduler'] = ok(undefined);
    mockQueries['device-responsibilities'] = ok({
      shiftId: 'S1',
      shiftUnknown: false,
      total: 0,
      covered: 0,
      gaps: 0,
      uncovered: 0,
      devices: [],
      notes: [],
    });
  });

  it('方案 403：不显示「当前无待审批/执行中方案」，KPI 也不显示 0', () => {
    mockQueries.schedulerActivePlans = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('当前无待审批/执行中方案');
    expect(markup).toContain('plans-error');
    // 待审批方案 KPI：数字必须退化为 —，并说明读取失败
    expect(markup).toContain('方案数据读取失败：数字不可用（不代表没有积压）');
    expect(markup).not.toContain('无积压');
  });

  it('执行记录 403：执行偏差 KPI 退化为 —，不显示"暂无偏差记录"', () => {
    mockQueries.schedulerExecutions = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('暂无偏差记录');
    expect(markup).toContain('执行记录读取失败：偏差数字不可用（不代表没有偏差）');
  });

  it('确实无方案/无执行记录（无错误）：仍显示原来的空态文案', () => {
    const markup = render();
    expect(markup).toContain('当前无待审批/执行中方案');
    expect(markup).toContain('暂无偏差记录');
    expect(markup).not.toContain('plans-error');
  });

  it('异常事件 403：不显示「近 24h 无 open 异常」', () => {
    mockQueries.factoryOperationsEvents = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('近 24h 无 open 异常');
    expect(markup).toContain('anomaly-error');
  });

  it('交接记录 403：不显示「暂无交接记录」', () => {
    mockQueries.shiftHandovers = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('暂无交接记录');
    expect(markup).toContain('handovers-error');
  });

  it('班次定义 403：不显示「未登记班次」', () => {
    mockQueries.shiftDefinitions = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('未登记班次');
    expect(markup).toContain('shift-defs-error');
  });

  it('当前班次 403：页头横幅说"读取失败"，不落回「不在任何班次窗口内」', () => {
    mockQueries.shiftCurrent = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('当前不在任何班次窗口内');
    expect(markup).not.toContain('无有效班次定义');
    expect(markup).toContain('班次信息读取失败');
  });

  it('数据质量判定提交成功后，失效键必须前缀匹配确认查询的真实缓存键', () => {
    // 确认查询键是 [org, 'data-quality-confirmations', eventIds]（租户分片）。
    // 旧代码失效 ['data-quality']——前缀匹配不到任何查询，判定提交成功后
    // 界面纹丝不动（按钮还在），用户会重复提交同一判定。
    mockQueries.factoryOperationsEvents = ok({
      items: [{ eventId: 'EVT-1', status: 'open', severity: 'L2', title: 'x' }],
      total: 1,
    });
    render();
    expect(mockMutationCalls.length).toBeGreaterThan(0);
    const dqMutation = mockMutationCalls[0];
    expect(typeof dqMutation.onSuccess).toBe('function');
    mockInvalidate.mockClear();
    (dqMutation.onSuccess as () => void).call(null);
    const invalidatedKeys = mockInvalidate.mock.calls.map(
      (call) => (call[0] as { queryKey?: unknown })?.queryKey,
    );
    expect(invalidatedKeys).toContainEqual(['org-under-test', 'data-quality-confirmations']);
  });
});
