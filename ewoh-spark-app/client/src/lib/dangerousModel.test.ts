import {
  DANGEROUS_IDLE,
  UNDO_WINDOW_MS,
  canUndo,
  createDangerIdempotencyKey,
  dangerousPhaseLabel,
  dangerousReducer,
  isUndoable,
} from './dangerousModel';

const impact = {
  action: 'delete' as const,
  targetType: 'workbench-view',
  targetId: 'operator.mySteps',
  summary: '删除视图',
  affectedCount: 1,
  irreversible: false,
  requiresConfirmation: true,
};

describe('dangerousModel (危险操作状态机)', () => {
  it('requires confirmation before executing (禁止未确认执行)', () => {
    // 从 idle 直接 confirm 不合法（无 impact，phase 非 confirm）。
    expect(dangerousReducer(DANGEROUS_IDLE, { type: 'confirm' }).phase).toBe('idle');
  });

  it('preview → confirm → confirm-success 完整闭环并记录审计', () => {
    let state = dangerousReducer(DANGEROUS_IDLE, {
      type: 'preview',
      idempotencyKey: 'k1',
    });
    expect(state.phase).toBe('previewing');

    state = dangerousReducer(state, { type: 'preview-success', impact });
    expect(state.phase).toBe('confirm');
    expect(state.impact).toEqual(impact);
    expect(state.idempotencyKey).toBe('k1');
    expect(state.audit.some((r) => r.event === 'impact-previewed')).toBe(true);

    state = dangerousReducer(state, { type: 'confirm' });
    expect(state.phase).toBe('confirming');

    const now = 1_000_000;
    state = dangerousReducer(state, {
      type: 'confirm-success',
      actionId: 'a1',
      compensation: { kind: 'undo', description: '撤销' },
      now,
    });
    expect(state.phase).toBe('executed');
    expect(state.actionId).toBe('a1');
    expect(state.undoDeadline).toBe(now + UNDO_WINDOW_MS);
    expect(state.audit.some((r) => r.event === 'confirmed')).toBe(true);
  });

  it('irreversible operations get no undo window', () => {
    let state = dangerousReducer(DANGEROUS_IDLE, { type: 'preview', idempotencyKey: 'k' });
    state = dangerousReducer(state, {
      type: 'preview-success',
      impact: { ...impact, irreversible: true },
    });
    state = dangerousReducer(state, { type: 'confirm' });
    state = dangerousReducer(state, {
      type: 'confirm-success',
      actionId: 'a',
      compensation: { kind: 'noop', description: '不可撤销' },
      now: 5,
    });
    expect(state.undoDeadline).toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('undo is only allowed within the window, once', () => {
    let state = dangerousReducer(DANGEROUS_IDLE, { type: 'preview', idempotencyKey: 'k' });
    state = dangerousReducer(state, { type: 'preview-success', impact });
    state = dangerousReducer(state, { type: 'confirm' });
    state = dangerousReducer(state, {
      type: 'confirm-success',
      actionId: 'a1',
      compensation: { kind: 'undo', description: '撤销' },
      now: 100,
    });
    expect(canUndo(state, 100 + UNDO_WINDOW_MS - 1)).toBe(true);
    expect(canUndo(state, 100 + UNDO_WINDOW_MS)).toBe(false);

    state = dangerousReducer(state, { type: 'undo' });
    state = dangerousReducer(state, { type: 'undo-success' });
    expect(state.phase).toBe('undone');
    expect(state.audit.some((r) => r.event === 'undone')).toBe(true);
    // 已撤销后不能再撤销。
    expect(canUndo(state)).toBe(false);
  });

  it('undo is rejected when there is no actionId or impact', () => {
    const state = dangerousReducer(DANGEROUS_IDLE, { type: 'preview', idempotencyKey: 'k' });
    expect(dangerousReducer(state, { type: 'undo' }).phase).toBe('previewing');
  });

  it('preview/confirm failures move to failed and label renders text', () => {
    const failed = dangerousReducer(DANGEROUS_IDLE, { type: 'preview-fail', error: '网络错误' });
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('网络错误');
    expect(dangerousPhaseLabel('confirm')).toBe('请二次确认该操作');
    expect(dangerousPhaseLabel('failed')).toBe('操作失败');
  });

  it('idempotency key is deterministic per action+target', () => {
    expect(createDangerIdempotencyKey('delete', 'workbench-view', 'operator.mySteps')).toBe(
      createDangerIdempotencyKey('delete', 'workbench-view', 'operator.mySteps'),
    );
    expect(createDangerIdempotencyKey('delete', 'workbench-view', 'a')).not.toBe(
      createDangerIdempotencyKey('delete', 'workbench-view', 'b'),
    );
  });

  it('isUndoable reflects the deadline window', () => {
    expect(isUndoable(100, 50)).toBe(true);
    expect(isUndoable(100, 100)).toBe(false);
    expect(isUndoable(null, 50)).toBe(false);
  });
});