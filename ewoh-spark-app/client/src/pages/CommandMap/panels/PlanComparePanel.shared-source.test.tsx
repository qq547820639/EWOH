/* PlanComparePanel 与 CommandMapShell 统一取数源回归测试（UR7 对抗审查）。
 *
 * 缺陷（修复前）：面板自带一份手动 fetch（本地 useState），而地图图层
 * PlanCompareLayer / PlanDiffDrawer 消费 CommandMapShell 的
 * ['scheduler-compare', baseline, candidate] React Query 缓存。同一对比存在
 * 两份不同时点的取数：打开对比后地图已经画出 diff（shell 自动查询），
 * 面板却显示空（等手动点击）；点击后面板结果取自第二次请求，方案在两次
 * 请求之间被 SSE 更新时，面板摘要与地图叠加层不一致。
 *
 * 修复后契约：
 *  - 面板与 shell 使用同一 queryKey（['scheduler-compare', baseline, candidate]），
 *    shell 已取到的权威 diff 直接命中缓存并渲染（不再出现"地图有、面板无"）；
 *  - 缓存命中时不再发起第二次 comparePlansV2 请求（消除双取数）。
 *
 * 测试环境为 node（本仓库无 jsdom/@testing-library），沿用 renderToString 模式：
 * SSR 首屏不执行 effect，等价于"shell 先取数、面板后挂载"的时序——预置缓存
 * 即可断言面板是否消费同一缓存。
 */
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PlanComparePanel from './PlanComparePanel';
import type { PlanCompareResult } from '@shared/api.interface';
import { DEFAULT_PLAN_COMPARE_UI } from '../vm/planCompareVM';

jest.mock('@client/src/api/scheduler', () => ({
  getActivePlans: jest.fn().mockResolvedValue([]),
  comparePlansV2: jest.fn(),
}));

const { comparePlansV2 } = jest.requireMock('@client/src/api/scheduler') as {
  comparePlansV2: jest.Mock;
};

function makeResult(): PlanCompareResult {
  return {
    baselinePlanId: 'P-BASE',
    candidatePlanId: 'P-CAND',
    added: ['T-NEW'],
    removed: [],
    diffByTask: [
      {
        taskId: 'T-1',
        changeTypes: ['PERSON_CHANGED'],
        reasons: ['人员变更'],
      },
    ],
    changeTypeCounts: { PERSON_CHANGED: 1 } as PlanCompareResult['changeTypeCounts'],
    churn: 1,
    aggregate: {},
  };
}

function renderPanel(queryClient: QueryClient): string {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <PlanComparePanel
        ui={{ ...DEFAULT_PLAN_COMPARE_UI, baselinePlanId: 'P-BASE', candidatePlanId: 'P-CAND' }}
        onUiChange={() => undefined}
        onOpenDiff={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('PlanComparePanel 统一取数源（UR7）', () => {
  beforeEach(() => {
    comparePlansV2.mockReset();
  });

  it('shell 已取到的对比结果（同 queryKey 缓存）→ 面板直接渲染，不再二次请求', () => {
    const queryClient = new QueryClient();
    // 模拟 shell 的自动查询已经取得权威 diff（面板打开时 shell 查询必然已启用）。
    queryClient.setQueryData(['scheduler-compare', 'P-BASE', 'P-CAND'], makeResult());

    const markup = renderPanel(queryClient);

    // 面板展示与地图图层同源的 diff 任务列表与摘要。
    expect(markup).toContain('T-1');
    expect(markup).toContain('P-BASE');
    expect(markup).toContain('P-CAND');
    // 单一取数源：缓存命中时不允许再发一次 comparePlansV2（修复前双取数）。
    expect(comparePlansV2).not.toHaveBeenCalled();
  });

  it('缓存未命中 → 面板不误报结果（等待 shell/手动查询），摘要区不渲染陈旧空态', () => {
    const queryClient = new QueryClient();
    const markup = renderPanel(queryClient);
    expect(markup).not.toContain('T-1');
    expect(comparePlansV2).not.toHaveBeenCalled();
  });
});
