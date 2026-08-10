// panels/schedule-panel-logic.ts — SchedulePanel 纯逻辑（可测试、无渲染依赖）
//
// Task 4 / P1：对比方案面板的「另一方案」选取。唯一约束：
// **绝不回退列表首个方案**——没有可对比的其他方案时返回 null（面板展示空/禁用态）。

import type { SchedulingPlanV2 } from '@shared/api.interface';

/**
 * 选取与当前选中方案不同的另一方案 id 用于对比。
 * - 无选中方案 → null（无从对比）；
 * - 不存在其他方案（plans 为空或只有选中方案）→ null（不取列表首个兜底）；
 * - 存在其他方案 → 返回第一个 planId !== selectedPlanId 的方案 id
 *   （保证「对比」双方不是同一方案）。
 */
export function pickComparePlanId(
  plans: SchedulingPlanV2[],
  selectedPlanId: string | null | undefined,
): string | null {
  if (!selectedPlanId) return null;
  const other = plans.find((p) => p.planId !== selectedPlanId);
  return other ? other.planId : null;
}
