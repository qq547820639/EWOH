/* Task 5 / P1：'Why did this task move?' 任务移动原因链 VM（纯函数，无因果推导）。
 *
 * 输入 = 服务端字段：PlanAssignmentDiff（old/new assignment + reasons）、
 * ReplanImpact（triggerType + reasons + 影响计数）、DecisionTrace（选中原因）。
 * 输出 = old→new 展示 + 原因链（严格按服务端给出的顺序拼接，不发明因果）。
 *
 * 原因链顺序（服务端数据顺序，不推断因果关系）：
 * 1) ReplanImpact.reasons（触发级原因码，如 DEVICE_OFFLINE:D-1）；
 * 2) PlanAssignmentDiff.reasons（任务级原因码）；
 * 3) DecisionTrace.selectedReason（求解器选中原因）。
 * 每段内部保持服务端顺序；跨段去重（保留首次出现）。
 */
import type { DecisionTrace, PlanAssignmentDiff, ReplanImpact } from '@shared/api.interface';
import { decisionReasonLabel } from './decisionExplainVM';

export interface TaskMoveResourceView {
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
}

export interface TaskMoveCauseStep {
  /** 原始原因码/文案（服务端字段）。 */
  code: string;
  /** 可读文案（仅映射已知原因，未知原样透传）。 */
  label: string;
  /** 来源段（trigger / diff / trace）。 */
  origin: 'trigger' | 'diff' | 'trace';
}

export interface TaskMoveExplainVM {
  taskId: string | null;
  /** 变更前分配（PlanAssignmentDiff.before，服务端字段）。 */
  old: TaskMoveResourceView;
  /** 变更后分配（PlanAssignmentDiff.after，服务端字段）。 */
  current: TaskMoveResourceView;
  changed: { person: boolean; device: boolean; station: boolean };
  /** 原因链：服务端顺序（trigger → diff → trace，各自内部保序，跨段去重）。 */
  causeChain: TaskMoveCauseStep[];
  /** ReplanImpact.triggerType（服务端字段）。 */
  triggerType: string | null;
  /** 未变化任务数（调用方由权威方案 diff 派生；null=无数据）。 */
  unchangedTaskCount: number | null;
  /** 变更任务总数（调用方由权威方案 diff 派生；null=无数据）。 */
  changedTaskCount: number | null;
  /** 未变化任务 id 列表（调用方由权威方案 diff 派生；最多展示前 N 个）。 */
  unchangedTaskIds: string[];
}

export interface TaskMoveExplainInput {
  /** 服务端单任务 diff（old/new assignment + reasons）。 */
  diff: PlanAssignmentDiff | null;
  /** Replan V2 影响模型（服务端字段，可选）。 */
  impact: ReplanImpact | null;
  /** 该任务的 DecisionTrace（服务端字段，可选）。 */
  trace: DecisionTrace | null;
  /** 未变化任务数（调用方由权威 diff 派生，可选）。 */
  unchangedTaskCount?: number | null;
  /** 变更任务总数（调用方由权威 diff 派生，可选）。 */
  changedTaskCount?: number | null;
  /** 未变化任务 id（调用方由权威 diff 派生，可选）。 */
  unchangedTaskIds?: string[];
}

/** 纯函数：diff/impact/trace → 任务移动解释模型（无 diff 数据时返回 null）。 */
export function taskMoveExplainVM(input: TaskMoveExplainInput): TaskMoveExplainVM | null {
  const { diff, impact, trace } = input;
  // 没有 old/new 对比数据就不构造移动解释（不伪造移动事实）。
  if (!diff) return null;

  const view = (snap: PlanAssignmentDiff['before']): TaskMoveResourceView => ({
    personId: snap?.personId ?? null,
    deviceId: snap?.deviceId ?? null,
    stationId: snap?.stationId ?? null,
    plannedStart: snap?.plannedStart ?? null,
    plannedEnd: snap?.plannedEnd ?? null,
  });

  const causeChain: TaskMoveCauseStep[] = [];
  const seen = new Set<string>();
  const pushCode = (code: string, origin: TaskMoveCauseStep['origin']): void => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    causeChain.push({ code, label: taskMoveReasonLabel(code), origin });
  };
  for (const r of impact?.reasons ?? []) pushCode(r, 'trigger');
  for (const r of diff.reasons ?? []) pushCode(r, 'diff');
  for (const r of trace?.selectedReason ?? []) pushCode(r, 'trace');

  const changed = {
    person: (diff.before?.personId ?? null) !== (diff.after?.personId ?? null),
    device: (diff.before?.deviceId ?? null) !== (diff.after?.deviceId ?? null),
    station: (diff.before?.stationId ?? null) !== (diff.after?.stationId ?? null),
  };

  return {
    taskId: diff.taskId ?? trace?.taskId ?? null,
    old: view(diff.before),
    current: view(diff.after),
    changed,
    causeChain,
    triggerType: impact?.triggerType ?? null,
    unchangedTaskCount: input.unchangedTaskCount ?? null,
    changedTaskCount: input.changedTaskCount ?? null,
    unchangedTaskIds: input.unchangedTaskIds ?? [],
  };
}

/** 触发码表（SchedulingTrigger 枚举 + 常用码；纯映射，不推导因果）。 */
export const TASK_MOVE_TRIGGER_LABELS: Record<string, string> = {
  MANUAL: '手动触发',
  TASK_CREATED: '任务创建',
  TASK_UPDATED: '任务更新',
  PERSON_UNAVAILABLE: '人员不可用',
  DEVICE_OFFLINE: '设备离线',
  DEVICE_LOW_BATTERY: '设备低电量',
  BOTTLENECK_DETECTED: '瓶颈检测',
  DEADLINE_AT_RISK: '交期风险',
  SAFETY_EVENT: '安全事件',
  ZONE_RESTRICTED: '区域受限',
  ROUTE_BLOCKED: '路线阻断',
  ROUTE_CONGESTED: '路线拥塞',
  RESERVATION_CONFLICT: '预占冲突',
  CHURN: '分配搅动最小化',
};

/** 原因码 → 可读文案（先查触发码表，再回退 decisionReasonLabel 的约束/拒绝码表）。 */
export function taskMoveReasonLabel(reason: string): string {
  const direct = TASK_MOVE_TRIGGER_LABELS[reason];
  if (direct) return direct;
  // 触发码可带实体后缀（如 'DEVICE_OFFLINE:D-1'），取冒号前段匹配（纯展示映射，非因果推导）。
  const prefix = reason.split(':')[0];
  if (prefix !== reason) {
    const fromPrefix = TASK_MOVE_TRIGGER_LABELS[prefix] ?? decisionReasonLabel(prefix);
    if (fromPrefix !== prefix) return fromPrefix;
  }
  const fallback = decisionReasonLabel(reason);
  // decisionReasonLabel 未知时原样透传（未知码不伪造文案）。
  return fallback === reason ? reason : fallback;
}
