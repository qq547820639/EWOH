import { useCallback, useReducer } from 'react';
import {
  confirmDangerous,
  previewDangerousImpact,
  undoDangerous,
  type DangerousActionKind,
} from '../api/operations';
import {
  createDangerIdempotencyKey,
  dangerousReducer,
  DANGEROUS_IDLE,
  type DangerousState,
} from './dangerousModel';

/**
 * 危险操作的 React 封装：把 api/operations 的三段式接口（预览/确认/撤销）
 * 接入 dangerousModel 状态机，并自动生成幂等键。纯 UI 会话状态，可用
 * dangerousModel 的 reducer 单独单测。
 */
export function useDangerousConfirm() {
  const [state, dispatch] = useReducer(dangerousReducer, DANGEROUS_IDLE);

  /** 发起一次危险操作：生成幂等键并拉取影响预览。 */
  const preview = useCallback(
    async (input: {
      action: DangerousActionKind;
      targetType: string;
      targetId: string;
      affectedCount?: number;
    }) => {
      const idempotencyKey = createDangerIdempotencyKey(
        input.action,
        input.targetType,
        input.targetId,
      );
      dispatch({ type: 'preview', idempotencyKey });
      try {
        const impact = await previewDangerousImpact(input);
        dispatch({ type: 'preview-success', impact });
      } catch (error) {
        dispatch({
          type: 'preview-fail',
          error: error instanceof Error ? error.message : '影响预览失败',
        });
      }
    },
    [],
  );

  /** 二次确认后执行。
   * 幂等键在预览阶段已确定，这里复用同一键，网络重试不会重复提交。 */
  const confirm = useCallback(
    async (input: {
      action: DangerousActionKind;
      targetType: string;
      targetId: string;
      affectedCount?: number;
      reason?: string;
    }) => {
      dispatch({ type: 'confirm' });
      try {
        const result = await confirmDangerous({
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          affectedCount: input.affectedCount,
          reason: input.reason,
          idempotencyKey: state.idempotencyKey ?? undefined,
        });
        dispatch({
          type: 'confirm-success',
          actionId: result.actionId,
          compensation: result.compensation,
        });
        return result;
      } catch (error) {
        dispatch({
          type: 'confirm-fail',
          error: error instanceof Error ? error.message : '操作执行失败',
        });
        throw error;
      }
    },
    [state.idempotencyKey],
  );

  /** 撤销已执行的操作（须在可撤销窗口内，否则状态机会拒绝）。 */
  const undo = useCallback(async () => {
    dispatch({ type: 'undo' });
    try {
      if (!state.actionId || !state.impact) throw new Error('缺少撤销所需上下文');
      await undoDangerous(state.actionId, {
        targetType: state.impact.targetType,
        targetId: state.impact.targetId,
      });
      dispatch({ type: 'undo-success' });
    } catch (error) {
      dispatch({
        type: 'undo-fail',
        error: error instanceof Error ? error.message : '撤销失败',
      });
    }
  }, [state.actionId, state.impact]);

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, preview, confirm, undo, reset } as {
    state: DangerousState;
    preview: (input: Parameters<typeof preview>[0]) => Promise<void>;
    confirm: (input: Parameters<typeof confirm>[0]) => Promise<unknown>;
    undo: () => Promise<void>;
    reset: () => void;
  };
}