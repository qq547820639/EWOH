/* ExoWorkbench 渲染 smoke（FE-1，§7/原则 7：缺失/不可信数据不得被静默伪造成确定事实）。
 *
 * 核心不变量：**次级查询失败时绝不出现「没有数据」类文案**。
 * 现场后果：/exo 对 worker 开放，而设备台账走 /api/dashboard/devices（角色不含 worker）→
 * worker 打开页面必得 403；旧代码只判 !isLoading，把"你没权限"渲染成
 * 「台账里还没有外骨骼类别设备」，用户于是以为"系统里就是没有"。
 *
 * 同款零网络做法：mock react-query / 全部 api 模块（api 层经 lib/http 使用 import.meta，
 * node 下无法加载），按 queryKey 返回可控状态。
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

const emptyState = (): MockQueryState => ({ data: undefined, isLoading: false, isError: false, error: null });

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = (options.queryKey ?? []).join('/');
    const short = key.split('/').slice(0, 2).join('/');
    const state = mockQueries[short] ?? emptyState();
    return { ...state, isFetching: false, dataUpdatedAt: 0, refetch: jest.fn() };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../api/exo', () => ({
  listExoSessions: jest.fn(),
  getExoDeviceContext: jest.fn(),
  getExoTelemetryConsistency: jest.fn(),
  getExoDeviationSummary: jest.fn(),
  startExoSession: jest.fn(),
  endExoSession: jest.fn(),
  abortExoSession: jest.fn(),
  correctExoSessionWearer: jest.fn(),
}));
jest.mock('../../api/dashboard', () => ({ searchDevices: jest.fn() }));
jest.mock('../../api/organization', () => ({ listPersonnel: jest.fn() }));
jest.mock('../../hooks/queryKeys', () => ({ queryKeys: { notifications: ['notifications'] } }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ExoWorkbench = require('./ExoWorkbench').default;

const FORBIDDEN = {
  response: { status: 403, data: { error: { code: 'PERMISSION_DENIED', message: 'Forbidden' } } },
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ExoWorkbench />
    </MemoryRouter>,
  );
}

describe('ExoWorkbench 渲染（FE-1 次级查询失败不得渲染成业务空态）', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockQueries)) delete mockQueries[key];
    // 默认：除被测查询外全部成功且为空。
    mockQueries['exo/sessions'] = { data: [], isLoading: false, isError: false, error: null };
    mockQueries['exo/exo-devices'] = { data: [], isLoading: false, isError: false, error: null };
    mockQueries['exo/personnel'] = { data: [], isLoading: false, isError: false, error: null };
    mockQueries['exo/consistency'] = { data: { sessions: [] }, isLoading: false, isError: false, error: null };
    mockQueries['exo/deviation-summary'] = { data: undefined, isLoading: false, isError: false, error: null };
  });

  it('设备台账 403：渲染权限态，绝不显示「台账里还没有外骨骼设备」', () => {
    mockQueries['exo/exo-devices'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('台账里还没有外骨骼类别设备');
    // ErrorState 把 403 解析为 permission → 明确「权限不足」
    expect(markup).toContain('权限不足');
    expect(markup).toContain('exo-devices-error');
  });

  it('设备台账 500：渲染服务器错误态，同样不显示"没有设备"', () => {
    mockQueries['exo/exo-devices'] = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { response: { status: 500, data: { error: { message: 'boom' } } } },
    };
    const markup = render();
    expect(markup).not.toContain('台账里还没有外骨骼类别设备');
    expect(markup).toContain('服务器暂时不可用');
  });

  it('设备台账确实为空（无错误）：仍显示原来的空态文案', () => {
    const markup = render();
    expect(markup).toContain('台账里还没有外骨骼类别设备');
    expect(markup).not.toContain('权限不足');
  });

  it('设备台账加载中：不显示空态文案（不把"还没读到"当"没有"）', () => {
    mockQueries['exo/exo-devices'] = { data: undefined, isLoading: true, isError: false, error: null };
    const markup = render();
    expect(markup).not.toContain('台账里还没有外骨骼类别设备');
  });

  it('会话查询失败：不渲染「当前没有外骨骼会话记录」', () => {
    mockQueries['exo/sessions'] = { data: undefined, isLoading: false, isError: true, error: new Error('HTTP 500') };
    const markup = render();
    expect(markup).not.toContain('当前没有外骨骼会话记录');
    expect(markup).toContain('会话读取失败');
  });

  it('会话查询成功且为空：仍渲染「当前没有外骨骼会话记录」', () => {
    const markup = render();
    expect(markup).toContain('当前没有外骨骼会话记录');
  });

  it('人员名单失败：显式说明姓名退化为人员 ID，不让下拉空着像"没有人"', () => {
    mockQueries['exo/personnel'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).toContain('人员名单读取失败');
    expect(markup).toContain('exo-personnel-error');
  });
});
