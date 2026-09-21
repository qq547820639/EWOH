/* ApprovalConsole 渲染 smoke（FE-1，原则 7：缺失/不可信数据不得被静默伪造成确定事实）。
 *
 * 不变量：**查询失败时绝不出现「没有数据」类文案**。
 * 旧写法只有 authorizationQuery 判了 isError；agentQuery / schedulerQuery 读失败时
 * 合并结果 rows 退化为空 → 直接显示「当前没有待批审批。」——把"没读到"说成"没有待批"。
 * 通知中心与调度运行记录同理（"没有未读通知。"/"暂无运行记录。"）。
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
  isPending?: boolean;
  isError: boolean;
  error: unknown;
}

const mockQueries: Record<string, MockQueryState> = {};
const mockQueryOptions: Array<{ queryKey?: unknown[] }> = [];

const ok = (data?: unknown): MockQueryState => ({ data, isLoading: false, isError: false, error: null });

function mockStateFor(key: string): MockQueryState {
  if (mockQueries[key]) return mockQueries[key];
  if (key.startsWith('approvals|detail')) return mockQueries['approvals|detail'] ?? ok(undefined);
  return ok(undefined);
}

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    mockQueryOptions.push(options);
    const key = (options.queryKey ?? []).join('|');
    const state = mockStateFor(key);
    return { ...state, isFetching: false, dataUpdatedAt: 0, refetch: jest.fn() };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false, isError: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../hooks/queryKeys', () => ({
  queryKeys: {
    approvals: ['approvals'],
    notifications: ['notifications'],
    schedulerRuns: () => ['schedulerRuns'],
  },
}));
jest.mock('../../lib/telemetry', () => ({ track: jest.fn() }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../../api/approvals', () => ({
  getApprovalDetail: jest.fn(),
  listAgentPendingApprovals: jest.fn(),
  getNotificationMetrics: jest.fn(),
  listNotifications: jest.fn(),
  listCapabilityAuthorizations: jest.fn(),
  listSchedulerPendingApprovals: jest.fn(),
  markNotificationRead: jest.fn(),
  resolveAgentApproval: jest.fn(),
  retryNotification: jest.fn(),
  stepApprovalAction: jest.fn(),
}));
jest.mock('../../api/scheduler', () => ({ getRuns: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ApprovalConsole = require('./ApprovalConsole').default;

const FORBIDDEN = {
  response: { status: 403, data: { error: { code: 'PERMISSION_DENIED', message: 'Forbidden' } } },
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ApprovalConsole />
    </MemoryRouter>,
  );
}

describe('ApprovalConsole 查询键租户分片', () => {
  it('approval/detail and governance caches use tenant-scoped prefixes', () => {
    render();
    const keys = mockQueryOptions.map((options) => options.queryKey);
    expect(keys).toContainEqual(['approvals', 'agent']);
    expect(keys).toContainEqual(['approvals', 'scheduler']);
    expect(keys).toContainEqual(['approvals', 'authorizations']);
    expect(keys).toContainEqual(['notifications', 'governance']);
    expect(keys).toContainEqual(['approvals', 'detail', null]);
  });
});

describe('ApprovalConsole 渲染（FE-1 次级查询失败不得渲染成业务空态）', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockQueries)) delete mockQueries[key];
    mockQueryOptions.length = 0;
    mockQueries['approvals|agent'] = ok([]);
    mockQueries['approvals|scheduler'] = ok([]);
    mockQueries['approvals|authorizations'] = ok([]);
    mockQueries['notifications'] = ok([]);
    mockQueries['notifications|governance'] = ok(undefined);
    mockQueries['schedulerRuns'] = ok({ runs: [] });
  });

  it('Agent 待批查询 403：渲染权限态，绝不显示「当前没有待批审批。」', () => {
    mockQueries['approvals|agent'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('当前没有待批审批。');
    expect(markup).toContain('approvals-error');
    // 403 → 「权限不足」（ErrorState 统一解析，不在页面里自己判 status）
    expect(markup).toContain('权限不足');
    // 页头计数也不得伪造 0
    expect(markup).toContain('待批审批 — 项');
  });

  it('调度待批查询 403：同样不显示「当前没有待批审批。」', () => {
    mockQueries['approvals|scheduler'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('当前没有待批审批。');
    expect(markup).toContain('approvals-error');
  });

  it('两个待批查询都成功且为空：仍显示原来的空态文案', () => {
    const markup = render();
    expect(markup).toContain('当前没有待批审批。');
    expect(markup).not.toContain('approvals-error');
  });

  it('通知查询失败：不显示「没有未读通知。」', () => {
    mockQueries['notifications'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('没有未读通知。');
    expect(markup).toContain('notifications-error');
    expect(markup).toContain('未读通知 — 条');
    // 2026-09-13 对抗自查补口：通知中心小节标题此前仍渲染 "未读 0 · 已读 0 · 已处置 0"
    // ——错误态正上方挂着三个伪造的 0，与 FE-1 的不变量自相矛盾。
    expect(markup).not.toContain('未读 0');
    expect(markup).not.toContain('已处置 0');
  });

  it('通知查询成功且为空：小节标题仍显示 0 计数（0 此时是有依据的结论）', () => {
    const markup = render();
    expect(markup).toContain('未读 0');
  });

  it('授权查询 403：页头不伪造「当前没有执行边界授权记录」', () => {
    mockQueries['approvals|authorizations'] = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: FORBIDDEN,
    };
    const markup = render();
    expect(markup).not.toContain('当前没有执行边界授权记录');
    expect(markup).toContain('无法判断授权状态');
  });

  it('运行记录查询失败：不显示「暂无运行记录。」', () => {
    mockQueries['schedulerRuns'] = { data: undefined, isLoading: false, isError: true, error: FORBIDDEN };
    const markup = render();
    expect(markup).not.toContain('暂无运行记录。');
    expect(markup).toContain('runs-error');
  });

  it('运行记录成功且为空：仍显示「暂无运行记录。」', () => {
    const markup = render();
    expect(markup).toContain('暂无运行记录。');
    expect(markup).not.toContain('runs-error');
  });
});
