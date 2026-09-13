/* M05：DecisionTrace 解释纯选择器（Task Intelligence / RejectedCandidateExplain）。
 *
 * 消费服务端 DecisionTrace（heuristic 已产出 rejectedHard/hardConstraints/
 * softCosts/weightsSnapshot），前端只渲染不重算 hard constraints。
 * 纯函数、无 React 依赖、可 node 单测。禁止 import 任何 hard 判定逻辑。
 */
import type { DecisionTrace } from '@shared/api.interface';
import { rejectReasonLabel } from '@shared/reject-reason';

export interface RejectedHardItem {
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  rejectReasons: string[];
  /** 可读文案（仅映射已知原因；未知原样透传）。 */
  reasonLabels: string[];
}

export interface DecisionExplainVM {
  taskId: string;
  priorityLevel: string;
  priorityScore: number | null;
  priorityFactors: Array<{ key: string; label: string; value: number }>;
  selected: { personId: string | null; deviceId: string | null; stationId: string | null };
  selectedReason: string[];
  rejectedHard: RejectedHardItem[];
  hardConstraints: string[];
  softCosts: Record<string, number>;
  weightsSnapshot: Record<string, number>;
  stationContribution: { stationId: string | null; queueLength: number; changeover: boolean } | null;
}

/** 纯函数：DecisionTrace → 展示模型（rejectedHard 结构化，前端不重算）。 */
export function decisionExplainVM(trace: DecisionTrace | null | undefined): DecisionExplainVM | null {
  if (!trace) return null;
  const rejectedHard = (trace.rejectedHard ?? []).map((r) => ({
    ...r,
    reasonLabels: (r.rejectReasons ?? []).map(decisionReasonLabel),
  }));
  return {
    taskId: trace.taskId,
    priorityLevel: trace.priority.level,
    priorityScore: trace.priority.score ?? null,
    priorityFactors: (trace.priority.factors ?? []).map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      value: f.value,
    })),
    selected: {
      personId: trace.selected?.personId ?? null,
      deviceId: trace.selected?.deviceId ?? null,
      stationId: trace.selected?.stationId ?? null,
    },
    selectedReason: trace.selectedReason ?? [],
    rejectedHard,
    hardConstraints: trace.hardConstraints ?? [],
    softCosts: trace.softCosts ?? {},
    weightsSnapshot: trace.weightsSnapshot ?? {},
    stationContribution: trace.stationContribution ?? null,
  };
}

/**
 * 拒绝原因可读文案（唯一来源 `shared/reject-reason.ts`）。
 *
 * 词表同时覆盖：候选拒绝原因（snake）、冲突类型、决策痕迹硬约束（UPPER_SNAKE）
 * 与历史键；未登记键返回"未登记原因（key）"而不是裸英文键（原则 5/7）。
 */
export function decisionReasonLabel(reason: string): string {
  return rejectReasonLabel(reason);
}
