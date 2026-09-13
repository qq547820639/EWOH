// planStatusStepVM.ts — 方案状态流转指示纯函数（node 可测）。
//
// 值班员一眼看到方案卡在哪个环节：影子方案 → 已批准 → 已派工 → 执行中。
// 终态映射：completed 全链 done；draft/rejected/superseded 主链未推进（全 todo）。

import type { PlanStatus } from '@shared/scheduler';

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: '草稿',
  shadow: '影子方案',
  approved: '已批准',
  dispatched: '已派工',
  executing: '执行中',
  completed: '已完成',
  rejected: '已驳回',
  superseded: '已被替代',
  cancelled: '已取消',
};

export const PLAN_FLOW_STEPS: ReadonlyArray<PlanStatus> = [
  'shadow',
  'approved',
  'dispatched',
  'executing',
] as const;

export type PlanStepState = 'done' | 'current' | 'todo';

export interface PlanStatusStep {
  key: PlanStatus;
  label: string;
  state: PlanStepState;
}

export function planStatusSteps(status: PlanStatus): PlanStatusStep[] {
  if (status === 'completed') {
    return PLAN_FLOW_STEPS.map((key) => ({
      key,
      label: PLAN_STATUS_LABELS[key],
      state: 'done' as const,
    }));
  }
  if (
    status === 'draft'
    || status === 'rejected'
    || status === 'superseded'
    // cancelled：主链未推进到完成；取消发生在派工之后时 executed 段不可信，
    // 统一按"未完成"展示（取消事实见方案卡 cancel 摘要）。
    || status === 'cancelled'
  ) {
    return PLAN_FLOW_STEPS.map((key) => ({
      key,
      label: PLAN_STATUS_LABELS[key],
      state: 'todo' as const,
    }));
  }
  const idx = PLAN_FLOW_STEPS.indexOf(status);
  return PLAN_FLOW_STEPS.map((key, i) => ({
    key,
    label: PLAN_STATUS_LABELS[key],
    state: (i < idx ? 'done' : i === idx ? 'current' : 'todo') as PlanStepState,
  }));
}
