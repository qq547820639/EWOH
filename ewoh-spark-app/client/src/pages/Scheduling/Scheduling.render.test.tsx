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
jest.mock('../../hooks/queryKeys', () => ({ queryKeys: { schedulerActivePlans: ['plans'], schedulerRuns: () => ['runs'], schedulerPlan: (planId: string) => ['scheduler-plan', 'org-1', planId] } }));
jest.mock('../../hooks/queryConfig', () => ({ OPERATIONAL_REFETCH_INTERVAL_MS: 5000, QUERY_STALE_TIME_MS: 30000 }));
jest.mock('../../scheduler/SchedulerRealtimeProvider', () => ({ SchedulerRealtimeProvider: ({ children }: { children: unknown }) => children }));
jest.mock('../../lib/auth', () => ({
  getCurrentOperator: () => 'test-op',
  // B5 审批独立性：Scheduling.tsx 现依赖 getAuthUser 判定自批（createdBy 对比）
  getAuthUser: () => ({ userId: 'test-user', username: 'test-op', roles: ['dispatcher'], orgId: 'org-1' }),
}));
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

/* ===== NO-62c：方案过期诊断面板渲染 ===== */

describe('PlanStalenessPanel（NO-62c：过期可解释 + 一键重排）', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PlanStalenessPanel } = require('./PlanStalenessPanel');

  const REPORT = {
    snapshotVersion: 'WS-7',
    snapshotFound: true,
    stale: true,
    summary: '检测到 2 项外部变化，另有 1 项本方案自身效果',
    checkedAt: '2026-09-12T03:00:00.000Z',
    externalChangeCount: 2,
    selfInflictedCount: 1,
    changes: [
      {
        kind: 'entity_version',
        entityKey: 'task:T-1',
        entityType: 'task',
        entityId: 'T-1',
        change: 'changed',
        selfInflicted: false,
        label: 'task 版本 3 → 4',
      },
      {
        kind: 'entity_version',
        entityKey: 'device:AGV-9',
        entityType: 'device',
        entityId: 'AGV-9',
        change: 'removed',
        selfInflicted: true,
        label: 'device 消失（快照后被移除）',
      },
    ],
  };

  const PROPS = {
    planId: 'plan-001',
    report: REPORT,
    onReplan: NO_OP,
    onDismiss: NO_OP,
  };

  it('摊开差异事实：摘要 + 计数 + 逐项标签 + 自身效果标注', () => {
    const markup = renderToStaticMarkup(<PlanStalenessPanel {...PROPS} />);
    expect(markup).toContain('方案已过期：世界状态在生成之后发生了变化');
    expect(markup).toContain(REPORT.summary);
    expect(markup).toContain('WS-7');
    expect(markup).toContain('外部变化 2');
    expect(markup).toContain('本方案自身效果 1');
    expect(markup).toContain('task 版本 3 → 4');
    expect(markup).toContain('（本方案自身）');
  });

  it('提供一键重排，并明确"重排不绕过审批"（执行边界不被按钮弱化）', () => {
    const markup = renderToStaticMarkup(<PlanStalenessPanel {...PROPS} />);
    expect(markup).toContain('按最新状态重新排程');
    expect(markup).toContain('重排不绕过审批');
  });

  it('不支持重排的状态：按钮禁用但仍解释原因', () => {
    const markup = renderToStaticMarkup(
      <PlanStalenessPanel {...PROPS} replanAvailable={false} />,
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('该状态不支持直接重排');
  });

  it('没有差异明细时显式说明"后端未提供差异明细"，不假装有诊断', () => {
    const markup = renderToStaticMarkup(
      <PlanStalenessPanel
        {...PROPS}
        report={{ ...REPORT, changes: [], externalChangeCount: 0, selfInflictedCount: 0 }}
      />,
    );
    expect(markup).toContain('后端未提供差异明细');
  });

  it('NO-64a：分档可见——事实变化 / 依赖资源证据过期 / 仅证据老化', () => {
    const markup = renderToStaticMarkup(
      <PlanStalenessPanel
        {...PROPS}
        report={{
          ...REPORT,
          contentChangeCount: 1,
          blockedEvidenceCount: 1,
          evidenceAgedCount: 3,
          reason: 'EVIDENCE_STALE',
          changes: [
            { ...REPORT.changes[0], severity: 'content' as const },
            { ...REPORT.changes[1], severity: 'blocked_evidence' as const, usedByPlan: true },
          ],
        }}
      />,
    );
    expect(markup).toContain('事实变化 1');
    expect(markup).toContain('依赖资源证据过期 1');
    expect(markup).toContain('仅证据老化 3（不阻断）');
    expect(markup).toContain('（事实变化）');
    expect(markup).toContain('（方案依赖，证据已过期）');
  });

  it('快照已不可比时给出显式徽章（不许看起来像"有差异可比"）', () => {
    const markup = renderToStaticMarkup(
      <PlanStalenessPanel {...PROPS} report={{ ...REPORT, snapshotFound: false }} />,
    );
    expect(markup).toContain('快照已不可比');
  });
});
