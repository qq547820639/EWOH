// panels/schedule-panel-logic.ts — SchedulePanel 纯逻辑（可测试、无渲染依赖）
//
// Task 4 / P1：对比方案面板的「另一方案」选取。唯一约束：
// **绝不回退列表首个方案**——没有可对比的其他方案时返回 null（面板展示空/禁用态）。
//
// Task 10 / 10.2：危险操作「预览 → 确认」摘要纯构建器：
// - replanPreviewSummary：ReplanPreviewResult（后端 dry-run）→ 计数 + 指标增量行；
// - dispatchPlanSummary：待下发方案 → 确认对话框摘要（分配数/指标/求解器/版本）。

import type { ReplanPreviewResult, SchedulingPlanV2, SolverStatus } from '@shared/api.interface';

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

/**
 * 选取「上一已批准/已派工方案」id 用于回看对比（值班员评估回退到上一版）。
 * - 无选中方案 → null；
 * - 候选 = 非当前方案且状态 ∈ {approved, dispatched, executing, completed, superseded}
 *   （superseded = 被重排替代的旧版，是最接近"回退目标"的历史方案）；
 * - 按 createdAt 降序取最近的一个；无候选 → null（不兜底列表首个，同 pickComparePlanId 约束）。
 */
export function pickPreviousApprovedPlanId(
  plans: SchedulingPlanV2[],
  selectedPlanId: string | null | undefined,
): string | null {
  if (!selectedPlanId) return null;
  const candidates = plans
    .filter(
      (p) =>
        p.planId !== selectedPlanId &&
        ['approved', 'dispatched', 'executing', 'completed', 'superseded'].includes(p.status),
    )
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  return candidates.length > 0 ? candidates[0].planId : null;
}

/** 指标增量行（label + 数值 + 展示单位）。 */
export interface ReplanPreviewDeltaRow {
  key: string;
  label: string;
  value: number;
  unit: string;
}

/** Replan 确认对话框摘要（数据全部来自后端 preview，前端只做展示映射）。 */
export interface ReplanPreviewSummary {
  affectedTaskCount: number;
  changedAssignmentCount: number;
  unchangedAssignmentCount: number;
  addedAssignmentCount: number;
  removedAssignmentCount: number;
  deltas: ReplanPreviewDeltaRow[];
  baselinePlanId: string | null;
  candidatePlanId: string | null;
}

/** 纯函数：ReplanPreviewResult → 确认对话框摘要（无 preview → null）。 */
export function replanPreviewSummary(
  preview: ReplanPreviewResult | null | undefined,
): ReplanPreviewSummary | null {
  if (!preview) return null;
  return {
    affectedTaskCount: preview.affectedTaskCount,
    changedAssignmentCount: preview.changedAssignmentCount,
    unchangedAssignmentCount: preview.unchangedAssignmentCount,
    addedAssignmentCount: preview.addedAssignmentCount,
    removedAssignmentCount: preview.removedAssignmentCount,
    deltas: [
      { key: 'lateness', label: '迟到', value: preview.latenessDelta ?? 0, unit: 'min' },
      { key: 'travel', label: '路程', value: preview.travelDelta ?? 0, unit: 'min' },
      { key: 'workload', label: '负荷', value: preview.workloadDelta ?? 0, unit: '' },
      { key: 'stationWait', label: '工位等待', value: preview.stationWaitDelta ?? 0, unit: 'min' },
      { key: 'risk', label: '风险', value: preview.riskDelta ?? 0, unit: '' },
      { key: 'churn', label: '换人成本', value: preview.churnDelta ?? 0, unit: '' },
    ],
    baselinePlanId: preview.baselinePlanId ?? null,
    candidatePlanId: preview.candidatePlanId ?? null,
  };
}

/** DISPATCH 确认对话框摘要。 */
export interface DispatchPlanSummary {
  planId: string;
  planName: string | null;
  version: number;
  assignmentsCount: number;
  lateMinutes: number;
  walkingMeters: number;
  stationWaitMinutes: number;
  maxWorkload: number;
  solverStatus: SolverStatus | null;
  solverVersion: string | null;
  snapshotVersion: string | null;
  policyVersion: number | null;
}

/** 纯函数：待下发方案 → 确认对话框摘要（无方案 → null）。 */
export function dispatchPlanSummary(
  plan: SchedulingPlanV2 | null | undefined,
): DispatchPlanSummary | null {
  if (!plan) return null;
  return {
    planId: plan.planId,
    planName: plan.planName ?? null,
    version: plan.version,
    assignmentsCount: plan.assignments.length,
    lateMinutes: plan.metrics.lateMinutes,
    walkingMeters: plan.metrics.walkingMeters,
    stationWaitMinutes: plan.metrics.stationWaitMinutes,
    maxWorkload: plan.metrics.maxWorkload,
    solverStatus: plan.solverStatus ?? null,
    solverVersion: plan.solverVersion ?? null,
    snapshotVersion: plan.snapshotVersion ?? null,
    policyVersion: plan.policyVersion ?? null,
  };
}
