/* ExecutionReceiptRow 提交成功后的缓存失效测试（攻击面 d）。
 *
 * 不变量：回执写入执行事实后，**所有**消费执行记录的查询都必须失效——
 *  - 工厂运行台 ExecutionFeedback：键 queryKeys.schedulerExecutions(planId)（按方案过滤），
 *    无过滤时是 queryKeys.schedulerExecutions()（短键）；
 *  - 现场作业台 FieldOperations：键 queryKeys.schedulerExecutions('field-my-work')；
 *  - 班次工作台：键 queryKeys.schedulerExecutions()（执行偏差 KPI）。
 * React Query 前缀匹配规则：**更短的键**才能匹配更长的查询键。旧实现用
 * schedulerExecutions(execution.planId) 失效——既匹配不到无过滤的短键查询，
 * 也匹配不到 'field-my-work' / 全量执行列表，回执提交后其他视图 15–30s 内
 * 仍显示旧状态（如"进行中"），与刚提交的事实不一致。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const mockInvalidate = jest.fn();
const mockMutationOptions: Array<Record<string, unknown>> = [];

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  useMutation: (options: Record<string, unknown>) => {
    mockMutationOptions.push(options);
    return { mutate: jest.fn(), isPending: false, error: null };
  },
  useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, isError: false, error: null, refetch: jest.fn(), dataUpdatedAt: 0 }),
}));

jest.mock('../../api/scheduler', () => ({ listExecutions: jest.fn(), updateExecution: jest.fn() }));
jest.mock('../../lib/auth', () => ({
  getAuthUser: () => ({ userId: 'u1', username: 'op-1', roles: ['workshop_lead'], orgId: 'org-9' }),
}));

import { queryKeys } from '../../hooks/queryKeys';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExecutionReceiptRow } = require('./ExecutionFeedback');

const EXECUTION = {
  executionId: 'EXE-1',
  assignmentId: 'ASG-1',
  taskId: 'T-1',
  planId: 'PLAN-1',
  status: 'STARTED',
  personId: 'P-1',
  plannedStartAt: '2026-09-13T00:00:00.000Z',
  actualStartAt: '2026-09-13T00:05:00.000Z',
};

function isPrefix(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  return prefix.length <= key.length && prefix.every((v, i) => JSON.stringify(v) === JSON.stringify(key[i]));
}

describe('ExecutionReceiptRow · 提交成功后的缓存失效', () => {
  beforeEach(() => {
    mockInvalidate.mockClear();
    mockMutationOptions.length = 0;
  });

  it('成功后用执行记录短键前缀失效：同时命中按方案过滤、field/my-work、全量列表', () => {
    renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionReceiptRow execution={EXECUTION} current />
      </MemoryRouter>,
    );
    const onSuccess = mockMutationOptions[0].onSuccess as (result: unknown) => void;
    expect(typeof onSuccess).toBe('function');
    onSuccess({ ...EXECUTION, status: 'COMPLETED' });

    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    const invalidated = mockInvalidate.mock.calls[0][0]?.queryKey as readonly unknown[];
    // 前缀键本身 = queryKeys.schedulerExecutionsPrefix（公共前缀，无过滤段）。
    expect(invalidated).toEqual(queryKeys.schedulerExecutionsPrefix);
    // 必须前缀匹配三类消费键。
    expect(isPrefix(invalidated, queryKeys.schedulerExecutions('PLAN-1'))).toBe(true);
    expect(isPrefix(invalidated, queryKeys.schedulerExecutions('field-my-work'))).toBe(true);
    expect(isPrefix(invalidated, queryKeys.schedulerExecutions())).toBe(true);
  });
});
