/**
 * 危险操作状态机（纯逻辑，node 可测，无 React/DOM）。
 *
 * 覆盖工业工作台对危险操作（清空/删除/批量取消/导出等不可逆动作）的完整保障闭环：
 *   影响预览 → 二次确认 → 幂等提交 → 操作结果 → 可撤销窗口 → 审计记录。
 *
 * 该模型与 `api/operations.ts` 的 previewDangerousImpact / confirmDangerous /
 * undoDangerous 一一对应，但把「UI 会话内的状态迁移」建模为可重放的 reducer，
 * 便于单测覆盖非法迁移（未确认就执行、已撤销后再次撤销等）。
 */

export type DangerousActionKind =
  | 'transfer'
  | 'approve'
  | 'delete'
  | 'cancel'
  | 'resolve';

export interface DangerousImpact {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  summary: string;
  affectedCount: number;
  irreversible: boolean;
  requiresConfirmation: boolean;
}

export type DangerousPhase =
  | 'idle'
  | 'previewing'
  | 'confirm'
  | 'confirming'
  | 'executed'
  | 'undone'
  | 'failed';

export interface DangerousState {
  phase: DangerousPhase;
  /** 影响预览（二次确认所需的事实依据）。 */
  impact: DangerousImpact | null;
  /** 幂等键：同一操作+同一目标确定生成，防重复提交。 */
  idempotencyKey: string | null;
  /** 确认成功后的 actionId（用于撤销）。 */
  actionId: string | null;
  /** 补偿方式（undo / restore / noop）。 */
  compensation: { kind: 'undo' | 'restore' | 'noop'; description: string } | null;
  /** 可撤销窗口（确认成功时刻 + 窗口时长，毫秒 epoch）。 */
  undoDeadline: number | null;
  /** 审计记录（每次操作结果累计）。 */
  audit: AuditRecord[];
  /** 最近一次错误信息。 */
  error: string | null;
}

export interface AuditRecord {
  at: string;
  event: string;
  action: DangerousActionKind | null;
  targetType: string | null;
  targetId: string | null;
  actionId: string | null;
  idempotencyKey: string | null;
  detail: string;
}

/** 可撤销窗口时长（ms）。 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/** FNV-1a 32 位哈希，确定性生成幂等键（无密码学诉求，纯函数可测）。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 生成危险操作的幂等键：同一操作 + 同一目标（含目标类型/ID）必然得到相同键，
 * 防止重复点击/网络重试造成重复提交或重复撤销。
 */
export function createDangerIdempotencyKey(
  action: DangerousActionKind,
  targetType: string,
  targetId: string,
): string {
  return fnv1a(`danger:${action}:${targetType}:${targetId}`);
}

export type DangerousAction =
  | { type: 'preview'; idempotencyKey: string }
  | { type: 'preview-success'; impact: DangerousImpact }
  | { type: 'preview-fail'; error: string }
  | { type: 'confirm' }
  | { type: 'confirm-success'; actionId: string; compensation: { kind: 'undo' | 'restore' | 'noop'; description: string }; now?: number }
  | { type: 'confirm-fail'; error: string }
  | { type: 'undo' }
  | { type: 'undo-success'; now?: number }
  | { type: 'undo-fail'; error: string }
  | { type: 'reset' };

export const DANGEROUS_IDLE: DangerousState = {
  phase: 'idle',
  impact: null,
  idempotencyKey: null,
  actionId: null,
  compensation: null,
  undoDeadline: null,
  audit: [],
  error: null,
};

function audit(
  record: AuditRecord,
  state: DangerousState,
): DangerousState {
  return { ...state, audit: [...state.audit, record] };
}

/** 判定某次操作结果是否仍处于可撤销窗口内。 */
export function isUndoable(
  undoDeadline: number | null,
  now = Date.now(),
): boolean {
  return undoDeadline !== null && now < undoDeadline;
}

/**
 * 危险操作状态迁移。不变量：
 * - 只有 `confirm` 阶段可执行 `confirm`；只有 `executed` 且未撤销才可 `undo`
 *   （时间窗口由调用方依据 `canUndo` 把关，undo-success 后进入 `undone` 即不可再撤销）。
 * - 幂等键在 `preview` 时确定，全程不变。
 */
export function dangerousReducer(
  state: DangerousState,
  action: DangerousAction,
): DangerousState {
  switch (action.type) {
    case 'preview':
      return {
        ...state,
        phase: 'previewing',
        idempotencyKey: action.idempotencyKey,
        impact: null,
        actionId: null,
        compensation: null,
        undoDeadline: null,
        error: null,
      };
    case 'preview-success':
      return audit(
        {
          at: new Date().toISOString(),
          event: 'impact-previewed',
          action: action.impact.action,
          targetType: action.impact.targetType,
          targetId: action.impact.targetId,
          actionId: null,
          idempotencyKey: state.idempotencyKey,
          detail: action.impact.summary,
        },
        {
          ...state,
          phase: action.impact.requiresConfirmation ? 'confirm' : 'executed',
          impact: action.impact,
          error: null,
        },
      );
    case 'preview-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'confirm':
      // 仅当已展示影响预览（confirm 阶段）且操作要求确认时才允许执行。
      if (state.phase !== 'confirm' || !state.impact) return state;
      return { ...state, phase: 'confirming' };
    case 'confirm-success':
      if (state.phase !== 'confirming') return state;
      const nowMs = action.now ?? Date.now();
      return audit(
        {
          at: new Date().toISOString(),
          event: 'confirmed',
          action: state.impact?.action ?? null,
          targetType: state.impact?.targetType ?? null,
          targetId: state.impact?.targetId ?? null,
          actionId: action.actionId,
          idempotencyKey: state.idempotencyKey,
          detail: '二次确认通过',
        },
        {
          ...state,
          phase: 'executed',
          actionId: action.actionId,
          compensation: action.compensation,
          undoDeadline: state.impact?.irreversible ? null : nowMs + UNDO_WINDOW_MS,
          error: null,
        },
      );
    case 'confirm-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'undo':
      // 仅校验状态合法性：已执行且存在 actionId。可撤销「时间窗口」由调用方
      // 依据 canUndo（可传入显式 now）在派发前把关，避免把真实时钟耦合进纯状态机。
      if (state.phase !== 'executed' || !state.actionId) {
        return state;
      }
      return { ...state, phase: 'confirming' };
    case 'undo-success': {
      if (state.phase !== 'confirming') return state;
      return audit(
        {
          at: new Date().toISOString(),
          event: 'undone',
          action: state.impact?.action ?? null,
          targetType: state.impact?.targetType ?? null,
          targetId: state.impact?.targetId ?? null,
          actionId: state.actionId,
          idempotencyKey: state.idempotencyKey,
          detail: '撤销成功',
        },
        { ...state, phase: 'undone', undoDeadline: null, error: null },
      );
    }
    case 'undo-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'reset':
      return DANGEROUS_IDLE;
    default:
      return state;
  }
}

/** 当前阶段对应的中文提示文案（供 UI 展示）。 */
export function dangerousPhaseLabel(phase: DangerousPhase): string {
  switch (phase) {
    case 'idle':
      return '';
    case 'previewing':
      return '正在评估影响…';
    case 'confirm':
      return '请二次确认该操作';
    case 'confirming':
      return '正在执行…';
    case 'executed':
      return '操作已执行';
    case 'undone':
      return '操作已撤销';
    case 'failed':
      return '操作失败';
    default:
      return '';
  }
}

/** 是否可展示『撤销』入口（已执行、可补偿、且在窗口内）。 */
export function canUndo(state: DangerousState, now = Date.now()): boolean {
  return (
    state.phase === 'executed' &&
    state.compensation !== null &&
    state.actionId !== null &&
    isUndoable(state.undoDeadline, now)
  );
}