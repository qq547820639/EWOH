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

export const TYPE_META: Record<SchedulingConflictType, { label: string }> = {
  double_booking: { label: '资源重复预占' },
  resource_stale: { label: '资源数据陈旧' },
  person_unavailable: { label: '人员不可用' },
  device_offline: { label: '设备离线' },
  low_battery: { label: '设备低电量' },
  predecessor_violation: { label: '前置任务未完成' },
  station_capacity: { label: '工位容量超限' },
  forbidden_zone: { label: '禁区进入' },
  safety_block: { label: '安全阻断' },
  blocked_route: { label: '路线阻断' },
  stale_plan: { label: '方案已过期' },
  reservation_conflict: { label: '预占资源不可用' },
  reservation_expiring: { label: '预占即将过期' },
};

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
