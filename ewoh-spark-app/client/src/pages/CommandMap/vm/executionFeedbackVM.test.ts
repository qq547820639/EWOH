// executionFeedbackVM.test.ts — 执行反馈视图模型纯函数测试（node 可测）。
//
// 覆盖：空态如实返回、汇总统计（执行中/完成/失败取消/按时率/平均延误）、
// 最近执行事件映射（状态文案/状态色/偏差标签/人员姓名回退）。
import {
  buildExecutionFeedbackView,
  DEVIATION_LABELS,
  EXECUTION_STATUS_LABELS,
} from './executionFeedbackVM';
import type { SchedulingExecution } from '@shared/scheduler';

function exec(overrides: Partial<SchedulingExecution>): SchedulingExecution {
  return {
    id: 'row-1',
    executionId: 'EXEC-1',
    orgId: null,
    runId: null,
    planId: 'PLAN-1',
    assignmentId: 'ASGN-1',
    taskId: 'TASK-1',
    personId: 'P-1',
    deviceId: null,
    stationId: null,
    plannedStartAt: null,
    plannedEndAt: null,
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: null,
    actualTravelMs: null,
    plannedDistanceM: null,
    actualDistanceM: null,
    plannedWaitingMs: null,
    actualWaitingMs: null,
    status: 'PLANNED',
    deviationType: null,
    deviationReason: null,
    snapshotVersion: null,
    policyVersion: null,
    solverVersion: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildExecutionFeedbackView', () => {
  it('空执行列表 → empty=true 且无汇总/最近项', () => {
    const view = buildExecutionFeedbackView({ executions: [] });
    expect(view.empty).toBe(true);
    expect(view.summary).toEqual([]);
    expect(view.recent).toEqual([]);
  });

  it('null 输入 → 空态（不静默透传 null）', () => {
    const view = buildExecutionFeedbackView({ executions: null });
    expect(view.empty).toBe(true);
  });

  it('汇总统计：执行中/完成/失败取消/按时完成率/平均延误', () => {
    const planned = '2026-08-14T08:00:00.000Z';
    const executions: SchedulingExecution[] = [
      exec({ taskId: 'T1', status: 'COMPLETED', plannedEndAt: planned, actualEndAt: '2026-08-14T07:50:00.000Z' }),
      exec({ taskId: 'T2', status: 'COMPLETED', plannedEndAt: planned, actualEndAt: '2026-08-14T08:30:00.000Z' }),
      exec({ taskId: 'T3', status: 'STARTED' }),
      exec({ taskId: 'T4', status: 'FAILED' }),
      exec({ taskId: 'T5', status: 'CANCELLED' }),
    ];
    const view = buildExecutionFeedbackView({ executions });
    expect(view.empty).toBe(false);
    const byLabel = Object.fromEntries(view.summary.map((r) => [r.label, r.value]));
    expect(byLabel['执行中']).toBe('1');
    expect(byLabel['已完成']).toBe('2');
    expect(byLabel['失败/取消']).toBe('1/1');
    expect(byLabel['按时完成率']).toBe('50%'); // 1/2 按时
    expect(byLabel['平均延误']).toBe('30.0min'); // 仅 T2 延误 30min
  });

  it('最近执行事件：状态文案/偏差标签/人员姓名回退', () => {
    const view = buildExecutionFeedbackView({
      executions: [
        exec({ taskId: 'T1', personId: 'P-1', status: 'FAILED', deviationType: 'DEVICE_FAILURE' }),
        exec({ taskId: 'T2', personId: null, status: 'COMPLETED', deviationType: null }),
      ],
      personNameOf: (id) => (id === 'P-1' ? '张三' : null),
    });
    expect(view.recent).toHaveLength(2);
    expect(view.recent[0].personLabel).toBe('张三');
    expect(view.recent[0].statusLabel).toBe(EXECUTION_STATUS_LABELS.FAILED);
    expect(view.recent[0].statusTone).toBe('negative');
    expect(view.recent[0].deviationLabel).toBe(DEVIATION_LABELS.DEVICE_FAILURE);
    expect(view.recent[1].personLabel).toBe('—');
    expect(view.recent[1].deviationLabel).toBeNull();
  });

  it('最多展示 5 条最近执行事件', () => {
    const executions = Array.from({ length: 8 }, (_, i) =>
      exec({ executionId: `E-${i}`, taskId: `T-${i}` }),
    );
    const view = buildExecutionFeedbackView({ executions });
    expect(view.recent).toHaveLength(5);
    expect(view.recent[0].taskId).toBe('T-0');
  });

  it('状态文案覆盖全部 7 个执行状态', () => {
    const statuses = [
      'PLANNED',
      'DISPATCHED',
      'STARTED',
      'PAUSED',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ] as const;
    for (const status of statuses) {
      expect(EXECUTION_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
