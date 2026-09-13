/* 分波次派工（部分执行）派生逻辑（纯函数，可单测）。
 *
 * 这一层承载的是**后果表达**，而不是布局：
 *  - 派工是**不可逆**的：它会写入资源预约并把任务推进到 dispatched，系统没有
 *    "取消派工"接口。因此确认文案必须写明条数、剩余、以及是否使方案进入终态
 *    （终态后不能再加波）。
 *  - 批量操作必须**声明条数**：一次派 1 条与一次派 16 条的风险完全不同，
 *    隐藏条数会让用户派超出预期（破坏半径随选择范围放大）。
 *  - 不得把"未知"说成"没有"：assignment 状态缺失时不计入待派工，也不假装已派工。
 */

import type { SchedulingAssignment } from '@shared/scheduler';

/** 可被派工的 assignment 状态（与后端"显式分区"的口径一致）。 */
export const PENDING_ASSIGNMENT_STATUSES = ['proposed', 'approved'] as const;
/** 已提交状态：不可再次派工（波内混入会被服务端整体拒绝）。 */
export const COMMITTED_ASSIGNMENT_STATUSES = ['dispatched', 'executing', 'completed'] as const;

export interface WaveCandidate {
  assignmentId: string;
  taskId: string;
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  status: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  /** 已提交（不可再派）——用于解释"为什么这一条不能选"。 */
  committed: boolean;
}

/** assignment 是否可派工。状态未知/缺失 → 不可派工（fail-closed，不猜）。 */
export function isPendingAssignment(status: string | null | undefined): boolean {
  return !!status && (PENDING_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** 把方案里的 assignment 投影为派工候选（保持服务端返回顺序）。 */
export function toWaveCandidates(assignments: SchedulingAssignment[] | null | undefined): WaveCandidate[] {
  return (assignments ?? []).map((a) => ({
    assignmentId: a.assignmentId,
    taskId: a.taskId,
    personId: a.personId ?? null,
    deviceId: a.deviceId ?? null,
    stationId: a.stationId ?? null,
    status: a.status,
    plannedStartAt: isoOrNull((a as { plannedStart?: string }).plannedStart),
    plannedEndAt: isoOrNull((a as { plannedEnd?: string }).plannedEnd),
    committed: (COMMITTED_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
  }));
}

export function pendingCandidates(candidates: WaveCandidate[]): WaveCandidate[] {
  return candidates.filter((c) => isPendingAssignment(c.status));
}

export type WaveValidation =
  | { ok: true }
  | { ok: false; reason: 'empty_selection' | 'unknown_selection' | 'no_pending' };

/** 校验选择是否可提交；不依赖服务端往返就能给出明确原因。 */
export function validateWaveSelection(
  candidates: WaveCandidate[],
  selectedIds: string[],
): WaveValidation {
  const pending = new Set(pendingCandidates(candidates).map((c) => c.assignmentId));
  if (pending.size === 0) return { ok: false, reason: 'no_pending' };
  if (selectedIds.length === 0) return { ok: false, reason: 'empty_selection' };
  if (selectedIds.some((id) => !pending.has(id))) return { ok: false, reason: 'unknown_selection' };
  return { ok: true };
}

export interface WaveConfirmCopy {
  /** 将被派发的条数（必须显式展示）。 */
  count: number;
  /** 派发后仍未派发的条数。 */
  remainingAfter: number;
  /** 本波是否覆盖全部剩余（决定方案是否进入终态）。 */
  completesPlan: boolean;
  title: string;
  /** 确切后果：条数 + 剩余 + 终态与否 + 不可逆性。 */
  consequence: string;
  /** 主按钮动词（不使用"确定/OK"这类无语义文案）。 */
  confirmLabel: string;
}

/**
 * 生成确认文案。刻意把"是否进入终态"写进后果——它是本波之后能否再加波的
 * 唯一分界，用户必须能在点击前从文字本身作出正确判断。
 */
export function buildWaveConfirmCopy(
  candidates: WaveCandidate[],
  selectedIds: string[],
): WaveConfirmCopy | null {
  const validation = validateWaveSelection(candidates, selectedIds);
  if (!validation.ok) return null;
  const pendingTotal = pendingCandidates(candidates).length;
  const count = selectedIds.length;
  const remainingAfter = pendingTotal - count;
  const completesPlan = remainingAfter === 0;
  return {
    count,
    remainingAfter,
    completesPlan,
    title: `派发本波 ${count} 条任务？`,
    consequence: completesPlan
      ? `本波将派完全部 ${pendingTotal} 条待派工任务，方案随即进入终态“已派发”，`
        + '之后不能再追加波次。派工会占用人员/设备/工位并写入预约，当前没有取消派工的接口。'
      : `本波派发 ${count} 条，派发后仍有 ${remainingAfter} 条待派工，`
        + '方案保持“已审批”（未进入终态），可继续分波派发。'
        + '派工会占用人员/设备/工位并写入预约，当前没有取消派工的接口。',
    confirmLabel: completesPlan ? `派完全部 ${count} 条` : `派发 ${count} 条`,
  };
}

/** 从服务端响应生成"本波结果"文案；无摘要时如实说明缺失。 */
export function describeWaveResult(dispatch: {
  dispatchedAssignments?: number;
  remainingAssignments?: number;
  planStatus?: string;
} | null | undefined): string {
  if (!dispatch || typeof dispatch.dispatchedAssignments !== 'number') {
    return '服务端未返回派工波次摘要，无法确认本波范围与剩余。请刷新方案详情核对。';
  }
  const remaining = dispatch.remainingAssignments;
  if (typeof remaining !== 'number') {
    // 缺失≠0：剩余数量缺失时不能断言"已无剩余、方案进入终态"——那会让调度员
    // 认为不能再追加波次而停止派工，剩余任务滞留（把缺失伪造成确定事实）。
    return `本波已派发 ${dispatch.dispatchedAssignments} 条 · 服务端未返回剩余数量，`
      + '无法确认方案是否已进入终态。请刷新方案详情核对后再决定是否继续分波。';
  }
  if (remaining > 0) {
    return `本波已派发 ${dispatch.dispatchedAssignments} 条 · 剩余 ${remaining} 条待派发`
      + '（方案仍为已审批，可继续分波派发）。';
  }
  return `本波已派发 ${dispatch.dispatchedAssignments} 条 · 已无剩余，方案进入终态「已派发」。`;
}

/** 选择集的稳定键（用于 React key 与幂等比较）。 */
export function selectionKey(ids: string[]): string {
  return [...ids].sort().join('|');
}
