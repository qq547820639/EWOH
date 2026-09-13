// panels/conflict-panel-logic.ts — ConflictCenterPanel 纯逻辑（可测试、无渲染依赖）
//
// v0.7 A3：把冲突类型映射与排序抽为纯函数模块：
// - TYPE_META：后端 SchedulingConflictType → 中文标签（防展示漂移，测试覆盖完整性）；
// - sortConflicts：按严重度（高 → 中 → 低）稳定排序，同严重度保持输入顺序。
//
// Task 10 / 10.2：生命周期操作（ack/resolve/suppress）确认对话框纯逻辑：
// - lifecycleReasonValid：reason 必填语义（沿用 window.prompt 时代的必填校验）；
// - buildLifecycleActionParams：构造与原 API 调用一致的 mutation 参数（不改变契约）。

import type {
  ConflictAction,
} from '../vm/conflictVM';
import type { SchedulingConflict, SchedulingConflictType } from '@shared/api.interface';
import { CONFLICT_TYPE_LABELS } from '@shared/reject-reason';

/**
 * 冲突类型元数据：文案来自**唯一词表** `shared/reject-reason.ts`
 * （此前本文件自建一张表，同一个键在不同面板有 3 种中文，见该模块头注释）。
 * 这里只做"类型 → 展示形状"的适配，不再维护第二份文案。
 */
export const TYPE_META: Record<SchedulingConflictType, { label: string }> = Object.fromEntries(
  (Object.keys(CONFLICT_TYPE_LABELS) as SchedulingConflictType[]).map((type) => [
    type,
    { label: CONFLICT_TYPE_LABELS[type] },
  ]),
) as Record<SchedulingConflictType, { label: string }>;

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** 按严重度稳定排序（高 → 中 → 低；同严重度保持后端顺序）。 */
export function sortConflicts<T extends { severity: string }>(conflicts: T[]): T[] {
  return [...conflicts].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  );
}

/** 生命周期操作确认框：reason 必填（空白/全空格视为无效，沿用原 window.prompt 语义）。 */
export function lifecycleReasonValid(reason: string): boolean {
  return Boolean(reason && reason.trim().length > 0);
}

/** 构造生命周期 mutation 参数（与原 API 调用契约一致：conflictId/action/operator/reason）。 */
export function buildLifecycleActionParams(
  conflict: SchedulingConflict,
  action: ConflictAction,
  operator: string,
  reason: string,
): { conflictId: string; action: ConflictAction; operator: string; reason: string } {
  return { conflictId: conflict.conflictId, action, operator, reason };
}
