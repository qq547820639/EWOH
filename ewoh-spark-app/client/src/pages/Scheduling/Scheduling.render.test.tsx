/* Scheduling.render.test.tsx — 调度方案卡片渲染 smoke（ADR-082，§17/§33）。
 *
 * R-89 模式推广：PlanCard 纯展示（状态标签/方案名/触发类型/时间戳/指标/
 * AI 解读/操作按钮）注入视图模型 → 契约字段透出。零网络。
 */
import { renderToStaticMarkup } from 'react-dom/server';

// lucide-react 图标在 node 环境下可能无法渲染 SVG → stub 为空 span。
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

// Scheduling.tsx 间接导入 api/scheduler（import.meta），需 mock。
jest.mock('../../api/scheduler', () => ({}));
jest.mock('../../hooks/queryKeys', () => ({ queryKeys: { schedulerActivePlans: ['plans'], schedulerRuns: () => ['runs'] } }));
jest.mock('../../hooks/queryConfig', () => ({ OPERATIONAL_REFETCH_INTERVAL_MS: 5000, QUERY_STALE_TIME_MS: 30000 }));
jest.mock('../../scheduler/SchedulerRealtimeProvider', () => ({ SchedulerRealtimeProvider: ({ children }: { children: unknown }) => children }));
jest.mock('../../lib/auth', () => ({ getCurrentOperator: () => 'test-op' }));
jest.mock('../../components/LazyPlanList', () => ({ LazyPlanList: () => null }));
jest.mock('../../components/QueryState', () => ({ __esModule: true, default: ({ children }: { children: unknown }) => children }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, isError: false, isStale: false, error: null, refetch: jest.fn(), dataUpdatedAt: 0 }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlanCard } = require('./Scheduling');
import type { SchedulingPlanV2 } from '@shared/api.interface';

const BASE_PLAN: SchedulingPlanV2 = {
  planId: 'plan-001',
  planName: '夜班排程 A',
  version: 2,
  status: 'draft',
  trigger: { type: 'DEVICE_OFFLINE', entityId: 'dev-1' },
  snapshotVersion: 'snap-1',
  policyVersion: 1,
  solverVersion: 'heuristic-v1',
  horizonMinutes: 480,
  assignments: [],
  metrics: {
    lateMinutes: 15.3,
    walkingMeters: 420,
    stationWaitMinutes: 8.7,
    maxWorkload: 0.72,
    changeCost: 0,
  },
  baselineDelta: {},
  violations: [],
  createdAt: '2026-08-16T08:00:00.000Z',
} as unknown as SchedulingPlanV2;

const NO_OP = () => {};

const CARD_PROPS = {
  row: BASE_PLAN,
  actionFor: null as string | null,
  actionMode: 'approve' as const,
  actionReason: '',
  approvePending: false,
  rejectPending: false,
  dispatchPending: false,
  replanPending: false,
  onStartAction: NO_OP,
  onCancelAction: NO_OP,
  onActionReasonChange: NO_OP,
  onHandleAction: NO_OP,
  onDispatch: NO_OP,
  onReplan: NO_OP,
};

describe('PlanCard 渲染 smoke（ADR-082）', () => {
  it('方案名/方案 id/状态标签/触发类型/时间戳透出', () => {
    const markup = renderToStaticMarkup(<PlanCard {...CARD_PROPS} />);
    expect(markup).toContain('夜班排程 A');
    expect(markup).toContain('plan-001');
    expect(markup).toContain('待审批');       // draft → 待审批
    expect(markup).toContain('设备离线');     // DEVICE_OFFLINE
    expect(markup).toContain('v2');
  });

  it('指标摘要透出：延期/移动/等待/负荷', () => {
    const markup = renderToStaticMarkup(<PlanCard {...CARD_PROPS} />);
    expect(markup).toContain('15min');        // 15.3 → 15
    expect(markup).toContain('420m');
    expect(markup).toContain('9min');         // 8.7 → 9
    expect(markup).toContain('72%');          // 0.72 → 72%
  });

  it('AI 解读层透出（aiNarration 非空）', () => {
    const planWithNarration = {
      ...BASE_PLAN,
      aiNarration: '设备 dev-1 离线，建议将任务转移至工位 B。',
      narrationSource: 'llm' as const,
    } as unknown as SchedulingPlanV2;
    const markup = renderToStaticMarkup(
      <PlanCard {...CARD_PROPS} row={planWithNarration} />,
    );
    expect(markup).toContain('AI 方案解读');
    expect(markup).toContain('设备 dev-1 离线');
  });

  it('AI 解读层缺省不渲染（aiNarration 为空）', () => {
    const markup = renderToStaticMarkup(<PlanCard {...CARD_PROPS} />);
    expect(markup).not.toContain('AI 方案解读');
    expect(markup).not.toContain('规则摘要');
  });

  it('已审批状态不显示待审批标签', () => {
    const approvedPlan = {
      ...BASE_PLAN,
      status: 'approved',
    } as unknown as SchedulingPlanV2;
    const markup = renderToStaticMarkup(
      <PlanCard {...CARD_PROPS} row={approvedPlan} />,
    );
    expect(markup).toContain('已审批');
    expect(markup).not.toContain('待审批');
  });
});
