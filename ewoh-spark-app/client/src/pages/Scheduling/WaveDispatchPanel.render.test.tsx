/* WaveDispatchPanel 渲染与缓存一致性测试。
 *
 * 不变量（CLI-715 + 攻击面 d）：
 *  1. 面板读取的方案详情必须走租户分片的 `queryKeys.schedulerPlan(planId)`——
 *     与对象工作台 / SSE 事件流共享同一份缓存。旧的裸键 ['plan-wave', planId]
 *     既没有 org 分片（跨租户切换账号会命中上一租户的缓存，确定性 planId 如
 *     种子数据 'PLAN-BASE-001' 可跨租户同名），也让同一份数据出现两个缓存副本
 *     （SSE 刷新其中一份，面板里还是旧的待派工集合，选中的 assignment 可能
 *     已被他人派发 → 整波 409）。
 *  2. 派工成功后，方案详情缓存与活跃方案列表必须一起前进——列表卡片若仍显示
 *     "已审批/下发执行"，用户再次点击只会得到 409 PLAN_NOT_APPROVED。
 */
import { renderToStaticMarkup } from 'react-dom/server';

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

const mockInvalidate = jest.fn();
const mockSetQueryData = jest.fn();
const mockQueryOptions: Array<Record<string, unknown>> = [];
const mockMutationOptions: Array<Record<string, unknown>> = [];

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate, setQueryData: mockSetQueryData }),
  useQuery: (options: Record<string, unknown>) => {
    mockQueryOptions.length = 0;
    mockQueryOptions.push(options);
    return {
      data: PLAN_DATA,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      dataUpdatedAt: Date.now(),
    };
  },
  useMutation: (options: Record<string, unknown>) => {
    mockMutationOptions.length = 0;
    mockMutationOptions.push(options);
    return { mutate: jest.fn(), isPending: false, error: null };
  },
}));

jest.mock('../../api/scheduler', () => ({
  getPlan: jest.fn(),
  dispatchPlanV2: jest.fn(),
}));

jest.mock('../../lib/auth', () => ({
  getAuthUser: () => ({ userId: 'u1', username: 'op-1', roles: ['dispatcher'], orgId: 'org-9' }),
  getCurrentOperator: () => 'op-1',
}));

import { queryKeys } from '../../hooks/queryKeys';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WaveDispatchPanel } = require('./WaveDispatchPanel');

const PLAN_DATA = {
  planId: 'PLAN-1',
  planName: '夜班排程',
  version: 1,
  status: 'approved',
  trigger: { type: 'MANUAL', entityId: null },
  snapshotVersion: 'snap-1',
  assignments: [
    { assignmentId: 'ASG-1', taskId: 'T1', personId: 'P1', deviceId: null, stationId: null, status: 'approved' },
    { assignmentId: 'ASG-2', taskId: 'T2', personId: 'P2', deviceId: null, stationId: null, status: 'approved' },
  ],
  metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0 },
};

function render(): string {
  return renderToStaticMarkup(<WaveDispatchPanel planId="PLAN-1" />);
}

describe('WaveDispatchPanel · 查询键与缓存一致性', () => {
  beforeEach(() => {
    mockInvalidate.mockClear();
    mockSetQueryData.mockClear();
    mockQueryOptions.length = 0;
    mockMutationOptions.length = 0;
  });

  it('面板读取方案详情走 queryKeys.schedulerPlan（租户分片、与详情页同键），不用裸键', () => {
    render();
    expect(mockQueryOptions[0].queryKey).toEqual(queryKeys.schedulerPlan('PLAN-1'));
  });

  it('派工成功后失效方案详情键，并把最新方案写回活跃方案列表', () => {
    render();
    const onSuccess = mockMutationOptions[0].onSuccess as (plan: unknown) => void;
    expect(typeof onSuccess).toBe('function');
    const dispatched = {
      ...PLAN_DATA,
      status: 'dispatched',
      dispatch: { dispatchedAssignments: 2, remainingAssignments: 0, planStatus: 'dispatched' },
    };
    mockInvalidate.mockClear();
    onSuccess(dispatched);

    expect(mockInvalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.schedulerPlan('PLAN-1') }),
    );

    const listCall = mockSetQueryData.mock.calls.find(
      (call) => JSON.stringify(call[0]) === JSON.stringify(queryKeys.schedulerActivePlans),
    );
    expect(listCall).toBeDefined();
    const updater = listCall![1] as (prev: Array<{ planId: string; status: string }> | undefined) => Array<{ planId: string; status: string }>;
    const next = updater([
      { planId: 'PLAN-1', status: 'approved' },
      { planId: 'PLAN-OTHER', status: 'draft' },
    ]);
    expect(next.find((p) => p.planId === 'PLAN-1')?.status).toBe('dispatched');
    expect(next.find((p) => p.planId === 'PLAN-OTHER')?.status).toBe('draft');
  });

  it('派工被整体拒绝时同样失效方案详情键（刷新后重新选择）', () => {
    render();
    const onError = mockMutationOptions[0].onError as (error: unknown) => void;
    expect(typeof onError).toBe('function');
    mockInvalidate.mockClear();
    const conflict = Object.assign(new Error('Request failed with status code 409'), {
      response: { status: 409, data: { error: { code: 'DISPATCH_WAVE_INVALID', message: '波内含已派工项' } } },
    });
    onError(conflict);
    expect(mockInvalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.schedulerPlan('PLAN-1') }),
    );
  });
});
