/**
 * Pure decision logic for "dangerous" Role Workbench actions (transfer,
 * approve, delete, cancel, resolve). These operations change business state, so
 * before they run the workbench must show:
 *   - an impact preview (what / how many records are affected, whether it is
 *     irreversible);
 *   - an explicit idempotent confirmation (a replayed request must not double
 *     apply or silently re-target);
 *   - a compensation / undo path where such a path exists.
 *
 * This module is pure and DB-free so it can be unit-tested without a database.
 */

export type DangerousActionKind =
  | 'transfer'
  | 'approve'
  | 'delete'
  | 'cancel'
  | 'resolve';

export const DANGEROUS_ACTION_KINDS: readonly DangerousActionKind[] = [
  'transfer',
  'approve',
  'delete',
  'cancel',
  'resolve',
];

export interface DangerousActionSpec {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  /** Number of underlying records affected by the action. */
  affectedCount?: number;
  /** Free-form reason the caller provides (optional). */
  reason?: string;
}

export interface DangerousImpact {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  summary: string;
  affectedCount: number;
  irreversible: boolean;
  requiresConfirmation: boolean;
}

const ACTION_LABELS: Record<DangerousActionKind, string> = {
  transfer: '转派',
  approve: '审批',
  delete: '删除',
  cancel: '取消',
  resolve: '强制解决',
};

const IRREVERSIBLE: Record<DangerousActionKind, boolean> = {
  transfer: false,
  approve: false,
  delete: true,
  cancel: true,
  resolve: false,
};

const ACTION_TEMPLATES: Record<DangerousActionKind, (n: number) => string> = {
  transfer: (n) => `将影响 ${n} 条记录的归属，转派后原责任人将无法继续处理。`,
  approve: (n) => `将批准 ${n} 条记录，审批通过后不可再退回原状。`,
  delete: (n) => `将删除 ${n} 条记录，删除后数据不可恢复。`,
  cancel: (n) => `将取消 ${n} 条记录，取消后不可重新激活。`,
  resolve: (n) => `将强制解决 ${n} 条记录，可能绕过正常流程约束。`,
};

/** Builds the impact summary the UI must show before executing the action. */
export function previewDangerousImpact(spec: DangerousActionSpec): DangerousImpact {
  const affectedCount = Math.max(1, spec.affectedCount ?? 1);
  return {
    action: spec.action,
    targetType: spec.targetType,
    targetId: spec.targetId,
    summary: `【${ACTION_LABELS[spec.action]}】${ACTION_TEMPLATES[spec.action](affectedCount)}`,
    affectedCount,
    irreversible: IRREVERSIBLE[spec.action],
    requiresConfirmation: true,
  };
}

/** Whether an action's effect cannot be undone (drives the confirmation copy). */
export function isIrreversible(action: DangerousActionKind): boolean {
  return IRREVERSIBLE[action];
}

export interface CompensationPlan {
  kind: 'undo' | 'restore' | 'noop';
  description: string;
}

/**
 * Describes the best available compensation / undo path for an action. `undo`
 * means the state can be reverted; `restore` means a restore entry exists but
 * is not automatic; `noop` means there is no compensation path and the action
 * must be treated as irreversible.
 */
export function buildCompensation(action: DangerousActionKind): CompensationPlan {
  switch (action) {
    case 'transfer':
      return {
        kind: 'undo',
        description: '可执行撤销转派，将记录归还给原责任人。',
      };
    case 'resolve':
      return {
        kind: 'undo',
        description: '可执行撤销强制解决，恢复工序原状态。',
      };
    case 'approve':
      return {
        kind: 'restore',
        description: '审批通过后不可直接撤回，需走重新评审流程。',
      };
    case 'delete':
    case 'cancel':
    default:
      return {
        kind: 'noop',
        description: '该操作不可撤销，请在确认前核对影响范围。',
      };
  }
}

/** Builds the idempotency key for a confirmed dangerous action. */
export function dangerousIdempotencyKey(
  action: DangerousActionKind,
  targetType: string,
  targetId: string,
): string {
  return `dangerous:${action}:${targetType}:${targetId}`;
}