/* Task 5 / P1：Decision Cockpit 统一决策上下文 VM（纯函数，无业务判定）。
 *
 * 输入 = 服务端字段（DecisionTrace / SchedulingConflict / TaskCandidatesResponse /
 * ReplanImpact / PlanCompareResult / SchedulingPlanV2 / SchedulingFeedback），
 * 输出 = 9 段决策上下文展示模型（WHAT_HAPPENED / WHY / IMPACT / SYSTEM_DECISION /
 * WHY_THIS_ASSIGNMENT / WHY_NOT_OTHERS / COST / RECOMMENDED_ACTION / ACTIONS）。
 *
 * 关键不变量（08 §10）：前端只渲染服务端数据，**禁止重算 hard constraints**——
 * 本 VM 不做任何资格/硬约束/优先级判定，只把服务端字段映射为展示行；
 * ACTIONS 适用性由调用方（UI 层）按数据存在性给出，本 VM 只做「动作 id → 文案」映射。
 */
import type {
  DecisionTrace,
  PlanAssignmentDiff,
  PlanCompareResult,
  ReplanImpact,
  SchedulingFeedback,
  SchedulingPlanV2,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import { decisionReasonLabel } from './decisionExplainVM';
import { taskMoveReasonLabel } from './taskMoveExplainVM';
import { SOLVER_STATUS_LABELS } from './solverStatusChainVM';

export type DecisionSectionId =
  | 'WHAT_HAPPENED'
  | 'WHY'
  | 'IMPACT'
  | 'SYSTEM_DECISION'
  | 'WHY_THIS_ASSIGNMENT'
  | 'WHY_NOT_OTHERS'
  | 'COST'
  | 'RECOMMENDED_ACTION'
  | 'ACTIONS';

export type DecisionRowTone = 'positive' | 'negative' | 'neutral' | 'warning';

export interface DecisionContextRow {
  /** 行标签（中文展示）。 */
  label: string;
  /** 行取值（服务端字段原样映射，不做推导）。 */
  value: string;
  /** 展示色调（纯展示元数据）。 */
  tone?: DecisionRowTone;
}

export interface DecisionContextSection {
  id: DecisionSectionId;
  title: string;
  rows: DecisionContextRow[];
}

export type DecisionActionId =
  | 'accept'
  | 'compare'
  | 'override'
  | 'lock'
  | 'exclude'
  | 'locate'
  | 'undo';

/** 动作 id → 展示文案（纯映射）。 */
export const DECISION_ACTION_LABELS: Record<DecisionActionId, string> = {
  accept: '确认处置',
  compare: '方案对比',
  override: '人工覆盖',
  lock: '锁定分配',
  exclude: '排除资源',
  locate: '定位',
  undo: '清除上下文',
};

/** 决策上下文输入：全部为服务端字段或调用方按服务端数据给出的展示计数。 */
export interface DecisionContextInput {
  taskId: string | null;
  /** 当前选中方案（SchedulingPlanV2，服务端方案）。 */
  plan: SchedulingPlanV2 | null;
  /** 选中任务的 DecisionTrace（服务端 assignment.decisionTrace）。 */
  trace: DecisionTrace | null;
  /** 命中选中任务的冲突（服务端 conflicts 列表条目的展示子集，可选）。 */
  conflict: DecisionConflictView | null;
  /** 选中任务的候选资源响应（服务端 TaskCandidatesResponse）。 */
  candidates: TaskCandidatesResponse | null;
  /** Replan V2 影响模型（服务端 ReplanImpact，可选）。 */
  replanImpact: ReplanImpact | null;
  /** 方案级权威 diff（服务端 PlanCompareResult，可选）。 */
  planDiff: PlanCompareResult | null;
  /** 选中任务的单条 diff（服务端 PlanAssignmentDiff，可选）。 */
  taskDiff: PlanAssignmentDiff | null;
  /** 执行反馈（服务端 SchedulingFeedback，可选；Command Map 页暂不拉取则传 null）。 */
  feedback: SchedulingFeedback | null;
  /** 未变化任务数（调用方由权威方案 assignments 派生，服务端 diff 已声明未触及）。 */
  unchangedTaskCount: number | null;
  /** 可用动作（调用方按数据存在性给出；本 VM 仅映射文案，不判定资格）。 */
  availableActions: DecisionActionId[];
}

/** 冲突展示子集（服务端 SchedulingConflict 字段直映，不含前端判定）。 */
export interface DecisionConflictView {
  type: string;
  severity: string;
  message: string;
  resolution: string | null;
  status?: string | null;
  detectedAt?: string | null;
  createdAt?: string | null;
  planId?: string | null;
}

export interface DecisionContextVM {
  taskId: string | null;
  /** 数据源版本追溯（全部来自服务端字段）。 */
  versions: {
    policyVersion: number | null;
    solverVersion: string | null;
    snapshotVersion: string | null;
  };
  /** 9 段决策上下文（无数据的段 rows 为空数组，由 UI 隐藏）。 */
  sections: DecisionContextSection[];
}

function push(rows: DecisionContextRow[], label: string, value: string | null | undefined, tone?: DecisionRowTone): void {
  if (value == null || value === '') return;
  rows.push({ label, value, tone });
}

function fmt(v: number | null | undefined): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

/** 纯函数：服务端决策字段 → 9 段决策上下文展示模型（不判资格/不重算硬约束）。 */
export function decisionContextVM(input: DecisionContextInput): DecisionContextVM | null {
  const { taskId, plan, trace, conflict, candidates, replanImpact, planDiff, taskDiff, feedback } = input;
  // 无任务也无方案上下文 → 空态（由 UI 展示空态提示）。
  if (!taskId && !plan && !conflict && !replanImpact) return null;

  const sections: DecisionContextSection[] = [];

  // ---- WHAT_HAPPENED：冲突/触发事件（服务端字段直映） ----
  const happenedRows: DecisionContextRow[] = [];
  push(happenedRows, '任务', taskId);
  if (conflict) {
    push(happenedRows, '冲突类型', `${conflict.type} · ${conflict.severity}`, 'negative');
    push(happenedRows, '冲突描述', conflict.message);
    push(happenedRows, '冲突状态', conflict.status ?? null);
    push(happenedRows, '冲突时间', conflict.detectedAt ?? conflict.createdAt ?? null);
  }
  if (replanImpact) {
    const triggerLabel = taskMoveReasonLabel(replanImpact.triggerType ?? '');
    push(happenedRows, '触发类型', triggerLabel || replanImpact.triggerType || null);
    push(
      happenedRows,
      '触发实体',
      Array.isArray(replanImpact.triggerIds) && replanImpact.triggerIds.length > 0
        ? replanImpact.triggerIds.join('、')
        : null,
    );
  }
  sections.push({ id: 'WHAT_HAPPENED', title: '发生了什么', rows: happenedRows });

  // ---- WHY：原因链（服务端顺序直映；replanImpact.reasons → diff.reasons） ----
  const whyRows: DecisionContextRow[] = [];
  const whyCodes: string[] = [];
  for (const r of replanImpact?.reasons ?? []) if (!whyCodes.includes(r)) whyCodes.push(r);
  for (const r of taskDiff?.reasons ?? []) if (!whyCodes.includes(r)) whyCodes.push(r);
  push(
    whyRows,
    '原因链',
    whyCodes.length > 0 ? whyCodes.map(taskMoveReasonLabel).join(' → ') : null,
  );
  sections.push({ id: 'WHY', title: '为什么（原因链）', rows: whyRows });

  // ---- IMPACT：影响范围（ReplanImpact 计数 + PlanCompareResult 计数，服务端权威） ----
  const impactRows: DecisionContextRow[] = [];
  if (replanImpact) {
    push(impactRows, '受影响任务', fmt(replanImpact.affectedTaskIds?.length), 'warning');
    push(impactRows, '可移动任务', fmt(replanImpact.movableAssignmentIds?.length));
    push(impactRows, '冻结任务', fmt(replanImpact.frozenAssignmentIds?.length));
    push(impactRows, '受影响资源', fmt(replanImpact.affectedResourceIds?.length));
  }
  if (planDiff) {
    const changed = planDiff.diffByTask.length + planDiff.added.length + planDiff.removed.length;
    push(impactRows, '变更任务', fmt(changed), 'warning');
    push(impactRows, '新增任务', fmt(planDiff.added.length));
    push(impactRows, '移除任务', fmt(planDiff.removed.length));
    push(impactRows, '换人成本', fmt(planDiff.churn));
  }
  if (input.unchangedTaskCount != null) {
    push(impactRows, '未变化任务', fmt(input.unchangedTaskCount), 'positive');
  }
  sections.push({ id: 'IMPACT', title: '影响范围', rows: impactRows });

  // ---- SYSTEM_DECISION：系统决策（方案字段直映 + 求解器状态链） ----
  const systemRows: DecisionContextRow[] = [];
  if (plan) {
    push(systemRows, '方案', plan.planName ?? plan.planId ?? null);
    push(systemRows, '方案状态', plan.status ?? null);
    push(systemRows, '触发', plan.trigger?.type ?? null);
    push(systemRows, '策略版本', fmt(plan.policyVersion));
    push(systemRows, '求解器版本', plan.solverVersion ?? null);
    const solverLabel = plan.solverStatus ? (SOLVER_STATUS_LABELS[plan.solverStatus] ?? plan.solverStatus) : null;
    push(systemRows, '求解器状态', solverLabel, plan.solverStatus === 'OPTIMAL' || plan.solverStatus === 'FEASIBLE' ? 'positive' : plan.solverStatus === 'HEURISTIC' ? 'neutral' : 'warning');
    push(systemRows, '快照版本', plan.snapshotVersion ?? null);
  }
  sections.push({ id: 'SYSTEM_DECISION', title: '系统决策', rows: systemRows });

  // ---- WHY_THIS_ASSIGNMENT：选中依据（DecisionTrace.selectedReason + priority.factors） ----
  const whyThisRows: DecisionContextRow[] = [];
  if (trace) {
    push(whyThisRows, '选中原因', trace.selectedReason?.length ? trace.selectedReason.join('；') : null);
    push(whyThisRows, '优先级', trace.priority?.level ?? null);
    push(whyThisRows, '优先级分', trace.priority?.score != null ? fmt(trace.priority.score) : null);
    const factorText = (trace.priority?.factors ?? [])
      .map((f) => `${f.label ?? f.key}${typeof f.value === 'number' ? `=${f.value}` : ''}`)
      .join('；');
    push(whyThisRows, '优先级因子', factorText || null);
  }
  sections.push({ id: 'WHY_THIS_ASSIGNMENT', title: '为何选中该分配', rows: whyThisRows });

  // ---- WHY_NOT_OTHERS：为何不选其他（rejectedAlternatives + rejectedHard + 候选计数） ----
  const whyNotRows: DecisionContextRow[] = [];
  const candidateTotal = candidates?.candidates?.length ?? trace?.candidates?.length ?? null;
  push(whyNotRows, '候选总数', candidateTotal != null ? String(candidateTotal) : null);
  push(whyNotRows, '硬约束拒绝数', trace?.rejectedHard?.length != null ? String(trace.rejectedHard.length) : null);
  for (const alt of trace?.rejectedAlternatives ?? []) {
    const who = [alt.personId, alt.deviceId, alt.stationId].filter(Boolean).join(' · ') || '未具名候选';
    push(whyNotRows, `未选 · ${who}`, (alt.reason ?? []).map(decisionReasonLabel).join('；') || null);
  }
  for (const hard of trace?.rejectedHard ?? []) {
    const who = [hard.personId, hard.deviceId, hard.stationId].filter(Boolean).join(' · ') || '未具名候选';
    push(whyNotRows, `硬拒 · ${who}`, (hard.rejectReasons ?? []).map(decisionReasonLabel).join('；') || null, 'warning');
  }
  sections.push({ id: 'WHY_NOT_OTHERS', title: '为何不选其他', rows: whyNotRows });

  // ---- COST：成本（DecisionTrace.softCosts + 方案 metrics，服务端字段直映） ----
  const costRows: DecisionContextRow[] = [];
  if (plan?.metrics) {
    push(costRows, '预计延期', plan.metrics.lateMinutes != null ? `${plan.metrics.lateMinutes.toFixed(0)} min` : null);
    push(costRows, '人员总移动', plan.metrics.walkingMeters != null ? `${plan.metrics.walkingMeters.toFixed(0)} m` : null);
    push(costRows, '工位等待', plan.metrics.stationWaitMinutes != null ? `${plan.metrics.stationWaitMinutes.toFixed(0)} min` : null);
    push(costRows, '最大负荷', plan.metrics.maxWorkload != null ? `${(plan.metrics.maxWorkload * 100).toFixed(1)}%` : null);
    push(costRows, '计划变更', plan.metrics.changeCost != null ? `${plan.metrics.changeCost.toFixed(0)} 项` : null);
  }
  for (const [key, value] of Object.entries(trace?.softCosts ?? {})) {
    push(costRows, `软成本 · ${key}`, typeof value === 'number' ? value.toFixed(2) : String(value));
  }
  sections.push({ id: 'COST', title: '成本', rows: costRows });

  // ---- RECOMMENDED_ACTION：建议处置（冲突 resolution，服务端字段） ----
  const actionRows: DecisionContextRow[] = [];
  if (conflict) {
    push(actionRows, '建议处置', conflict.resolution ?? null);
    push(actionRows, '关联方案', conflict.planId ?? null);
  }
  if (feedback) {
    push(actionRows, '执行反馈', feedback.accepted === null ? '未决' : feedback.accepted ? '已采纳' : '已拒绝');
  }
  sections.push({ id: 'RECOMMENDED_ACTION', title: '建议处置', rows: actionRows });

  // ---- ACTIONS：可用动作（调用方给出适用集合，本 VM 只映射文案） ----
  const actionRows2: DecisionContextRow[] = [];
  for (const id of input.availableActions) {
    push(actionRows2, DECISION_ACTION_LABELS[id] ?? id, '可执行');
  }
  sections.push({ id: 'ACTIONS', title: '操作', rows: actionRows2 });

  return {
    taskId,
    versions: {
      policyVersion: plan?.policyVersion ?? trace?.policyVersion ?? null,
      solverVersion: plan?.solverVersion ?? trace?.solverVersion ?? null,
      snapshotVersion: plan?.snapshotVersion ?? trace?.snapshotVersion ?? null,
    },
    sections,
  };
}
