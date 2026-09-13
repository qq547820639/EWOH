import {
  buildWaveConfirmCopy,
  describeWaveResult,
  isPendingAssignment,
  pendingCandidates,
  selectionKey,
  toWaveCandidates,
  validateWaveSelection,
  type WaveCandidate,
} from './waveDispatchLogic';
import type { SchedulingAssignment } from '@shared/scheduler';

function assignment(over: Partial<SchedulingAssignment> = {}): SchedulingAssignment {
  return {
    assignmentId: 'ASG-1',
    taskId: 'TASK-1',
    personId: 'p1',
    deviceId: null,
    stationId: 's1',
    status: 'approved',
    reasons: [],
    ...over,
  } as SchedulingAssignment;
}

const plan3 = [
  assignment({ assignmentId: 'ASG-1', taskId: 'T1' }),
  assignment({ assignmentId: 'ASG-2', taskId: 'T2' }),
  assignment({ assignmentId: 'ASG-3', taskId: 'T3' }),
];

describe('分波派工 · 候选与状态判定', () => {
  it('proposed 与 approved 都是可派工状态（shadow 方案是 proposed）', () => {
    expect(isPendingAssignment('proposed')).toBe(true);
    expect(isPendingAssignment('approved')).toBe(true);
  });

  it('已提交状态与未知状态都不可派工（fail-closed，不猜）', () => {
    for (const s of ['dispatched', 'executing', 'completed', 'cancelled', '', undefined, null]) {
      expect(isPendingAssignment(s as string)).toBe(false);
    }
  });

  it('投影保留服务端顺序并标记 committed', () => {
    const candidates = toWaveCandidates([
      assignment({ assignmentId: 'A', status: 'dispatched' }),
      assignment({ assignmentId: 'B', status: 'approved' }),
    ]);
    expect(candidates.map((c) => c.assignmentId)).toEqual(['A', 'B']);
    expect(candidates[0].committed).toBe(true);
    expect(candidates[1].committed).toBe(false);
  });

  it('非法时间字符串不进入展示字段（不伪造成时间）', () => {
    const [c] = toWaveCandidates([
      assignment({ plannedStart: 'not-a-date' } as never),
    ]);
    expect(c.plannedStartAt).toBeNull();
  });

  it('pendingCandidates 过滤掉已提交项', () => {
    const candidates = toWaveCandidates([
      assignment({ assignmentId: 'A', status: 'dispatched' }),
      assignment({ assignmentId: 'B', status: 'approved' }),
      assignment({ assignmentId: 'C', status: 'proposed' }),
    ]);
    expect(pendingCandidates(candidates).map((c) => c.assignmentId)).toEqual(['B', 'C']);
  });

  it('assignment 列表缺失时返回空候选，不崩溃', () => {
    expect(toWaveCandidates(null)).toEqual([]);
    expect(toWaveCandidates(undefined)).toEqual([]);
  });
});

describe('分波派工 · 选择校验', () => {
  const candidates: WaveCandidate[] = toWaveCandidates(plan3);

  it('未选择 → empty_selection', () => {
    expect(validateWaveSelection(candidates, [])).toEqual({ ok: false, reason: 'empty_selection' });
  });

  it('选择已提交/不存在的项 → unknown_selection（不静默忽略）', () => {
    expect(validateWaveSelection(candidates, ['ASG-1', 'ASG-XX']))
      .toEqual({ ok: false, reason: 'unknown_selection' });
    const withCommitted = toWaveCandidates([
      assignment({ assignmentId: 'A', status: 'dispatched' }),
      assignment({ assignmentId: 'B', status: 'approved' }),
    ]);
    expect(validateWaveSelection(withCommitted, ['A']))
      .toEqual({ ok: false, reason: 'unknown_selection' });
  });

  it('没有可派工项时 → no_pending（区别于"没选"）', () => {
    const allCommitted = toWaveCandidates([assignment({ status: 'dispatched' })]);
    expect(validateWaveSelection(allCommitted, [])).toEqual({ ok: false, reason: 'no_pending' });
  });

  it('合法选择通过', () => {
    expect(validateWaveSelection(candidates, ['ASG-1', 'ASG-2'])).toEqual({ ok: true });
  });
});

describe('分波派工 · 确认文案（必须命名确切后果）', () => {
  const candidates: WaveCandidate[] = toWaveCandidates(plan3);

  it('部分波：写明条数、剩余、保持已审批、不可逆', () => {
    const copy = buildWaveConfirmCopy(candidates, ['ASG-1'])!;
    expect(copy.count).toBe(1);
    expect(copy.remainingAfter).toBe(2);
    expect(copy.completesPlan).toBe(false);
    expect(copy.title).toContain('1 条');
    expect(copy.consequence).toContain('仍有 2 条待派工');
    expect(copy.consequence).toContain('未进入终态');
    expect(copy.consequence).toContain('没有取消派工的接口');
    expect(copy.confirmLabel).toBe('派发 1 条');
  });

  it('覆盖全部剩余：明确告知进入终态且不能再追加波次', () => {
    const copy = buildWaveConfirmCopy(candidates, ['ASG-1', 'ASG-2', 'ASG-3'])!;
    expect(copy.remainingAfter).toBe(0);
    expect(copy.completesPlan).toBe(true);
    expect(copy.consequence).toContain('进入终态');
    expect(copy.consequence).toContain('不能再追加波次');
    expect(copy.confirmLabel).toContain('派完全部 3 条');
  });

  it('主按钮使用真实动词，不用"确定/OK"', () => {
    const copy = buildWaveConfirmCopy(candidates, ['ASG-1'])!;
    expect(copy.confirmLabel).not.toMatch(/^(确定|确认|OK|是)$/i);
  });

  it('非法选择不产生确认文案（不给出可点击的危险入口）', () => {
    expect(buildWaveConfirmCopy(candidates, [])).toBeNull();
    expect(buildWaveConfirmCopy(candidates, ['ASG-XX'])).toBeNull();
  });
});

describe('分波派工 · 结果文案', () => {
  it('部分执行：说明剩余与仍可继续分波', () => {
    const text = describeWaveResult({ dispatchedAssignments: 1, remainingAssignments: 15, planStatus: 'approved' });
    expect(text).toContain('已派发 1 条');
    expect(text).toContain('剩余 15 条');
    expect(text).toContain('可继续分波派发');
  });

  it('覆盖全部：说明进入终态', () => {
    const text = describeWaveResult({ dispatchedAssignments: 16, remainingAssignments: 0, planStatus: 'dispatched' });
    expect(text).toContain('已无剩余');
    expect(text).toContain('终态');
  });

  it('缺摘要时如实说明缺失，不假装成功范围已知', () => {
    expect(describeWaveResult(null)).toContain('未返回派工波次摘要');
    expect(describeWaveResult({} as never)).toContain('未返回派工波次摘要');
  });

  it('缺 remainingAssignments 时不得把缺失补成 0、不得伪称方案进入终态', () => {
    // 最高纪律：缺失数据不得被伪造成确定事实。剩余数量缺失时，
    // "已无剩余、进入终态"会让调度员停止追加波次、剩余任务滞留。
    const text = describeWaveResult({ dispatchedAssignments: 3 } as never);
    expect(text).not.toContain('已无剩余');
    expect(text).not.toContain('方案进入终态');
    expect(text).toContain('未返回剩余数量');
  });
});

describe('分波派工 · 选择集键', () => {
  it('与顺序无关（同一集合同键）', () => {
    expect(selectionKey(['b', 'a'])).toBe(selectionKey(['a', 'b']));
    expect(selectionKey(['a'])).not.toBe(selectionKey(['a', 'b']));
  });
});
