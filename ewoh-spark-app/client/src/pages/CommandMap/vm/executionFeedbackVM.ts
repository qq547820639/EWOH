// executionFeedbackVM.ts — 执行反馈视图模型（纯映射，node 可测）。
//
// 闭合「派工后执行反馈断链」：决策驾驶舱原 SCHEDULING_FEEDBACK 段为显式空态，
// 现消费 GET /api/scheduler/executions（ewoh_scheduling_execution，planned vs
// actual + deviation 事实）映射为「汇总指标 + 最近执行事件」。
// 原则同 decisionContextVM：只映射服务端字段、只做展示层文案/状态色映射，
// 不重算任何资格/成本/硬约束；无数据显式返回 empty（不静默透传 null）。

import type { SchedulingExecution, SchedulingExecutionStatus } from '@shared/scheduler';

export type FeedbackTone = 'positive' | 'warning' | 'negative' | 'neutral';

export interface ExecutionFeedbackSummaryRow {
  label: string;
  value: string;
  tone: FeedbackTone;
}

export interface RecentExecutionItem {
  taskId: string;
  personId: string | null;
  personLabel: string;
  status: SchedulingExecutionStatus;
  statusLabel: string;
  statusTone: FeedbackTone;
  deviationLabel: string | null;
}

export interface ExecutionFeedbackView {
  empty: boolean;
  summary: ExecutionFeedbackSummaryRow[];
  recent: RecentExecutionItem[];
}

export const EXECUTION_STATUS_LABELS: Record<SchedulingExecutionStatus, string> = {
  PLANNED: '已计划',
  DISPATCHED: '已派工',
  STARTED: '执行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};

export const EXECUTION_STATUS_TONES: Record<SchedulingExecutionStatus, FeedbackTone> = {
  PLANNED: 'neutral',
  DISPATCHED: 'neutral',
  STARTED: 'positive',
  PAUSED: 'warning',
  COMPLETED: 'positive',
  FAILED: 'negative',
  CANCELLED: 'warning',
};

export const DEVIATION_LABELS: Record<string, string> = {
  START_DELAY: '开始延误',
  END_DELAY: '完成延误',
  TRAVEL_DELAY: '途中延误',
  PERSON_CHANGED: '人员变更',
  DEVICE_CHANGED: '设备变更',
  STATION_CHANGED: '工位变更',
  ROUTE_DEVIATION: '路线偏离',
  PERSON_UNAVAILABLE: '人员不可用',
  DEVICE_FAILURE: '设备故障',
  TASK_CANCELLED: '任务取消',
  SAFETY_INTERRUPTION: '安全中断',
  MANUAL_OVERRIDE: '人工覆盖',
};

function fmtMinutes(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const minutes = ms / 60_000;
  if (Math.abs(minutes) < 1) return `${Math.round(ms / 1000)}s`;
  return `${minutes.toFixed(1)}min`;
}

/**
 * 汇总指标：按执行记录统计（不依赖 feedback 表，试点期即可见）。
 * - 执行中：STARTED/PAUSED 数
 * - 已完成 / 失败 / 取消：终态计数
 * - 按时完成率：actualEnd<=plannedEnd 的 COMPLETED 占比（无数据 '—'）
 * - 平均延误：COMPLETED 且 actualEnd>plannedEnd 的均值（无数据 '—'）
 */
function buildSummary(executions: SchedulingExecution[]): ExecutionFeedbackSummaryRow[] {
  const running = executions.filter((e) => e.status === 'STARTED' || e.status === 'PAUSED').length;
  const completed = executions.filter((e) => e.status === 'COMPLETED').length;
  const failed = executions.filter((e) => e.status === 'FAILED').length;
  const cancelled = executions.filter((e) => e.status === 'CANCELLED').length;

  const withBoth = executions.filter(
    (e) => e.status === 'COMPLETED' && e.actualEndAt && e.plannedEndAt,
  );
  const onTime = withBoth.filter(
    (e) => new Date(e.actualEndAt as string).getTime() <= new Date(e.plannedEndAt as string).getTime(),
  ).length;
  const lateDeltas = withBoth
    .map(
      (e) =>
        new Date(e.actualEndAt as string).getTime() -
        new Date(e.plannedEndAt as string).getTime(),
    )
    .filter((d) => d > 0);

  const onTimeRate =
    withBoth.length > 0 ? `${Math.round((onTime / withBoth.length) * 100)}%` : '—';
  const meanLateness = lateDeltas.length > 0 ? fmtMinutes(lateDeltas.reduce((a, b) => a + b, 0) / lateDeltas.length) : '—';

  const rows: ExecutionFeedbackSummaryRow[] = [
    { label: '执行中', value: String(running), tone: running > 0 ? 'positive' : 'neutral' },
    { label: '已完成', value: String(completed), tone: completed > 0 ? 'positive' : 'neutral' },
    { label: '失败/取消', value: `${failed}/${cancelled}`, tone: failed > 0 ? 'negative' : 'neutral' },
    { label: '按时完成率', value: onTimeRate, tone: onTimeRate !== '—' && onTimeRate !== '100%' ? 'warning' : 'positive' },
    { label: '平均延误', value: meanLateness, tone: lateDeltas.length > 0 ? 'warning' : 'neutral' },
  ];
  return rows;
}

function buildRecent(
  executions: SchedulingExecution[],
  personNameOf?: (id: string | null) => string | null,
): RecentExecutionItem[] {
  return executions.slice(0, 5).map((e) => ({
    taskId: e.taskId,
    personId: e.personId,
    personLabel: personNameOf?.(e.personId) ?? e.personId ?? '—',
    status: e.status,
    statusLabel: EXECUTION_STATUS_LABELS[e.status] ?? e.status,
    statusTone: EXECUTION_STATUS_TONES[e.status] ?? 'neutral',
    deviationLabel: e.deviationType ? (DEVIATION_LABELS[e.deviationType] ?? e.deviationType) : null,
  }));
}

export function buildExecutionFeedbackView(input: {
  executions?: SchedulingExecution[] | null;
  personNameOf?: (id: string | null) => string | null;
}): ExecutionFeedbackView {
  const executions = input.executions ?? [];
  if (executions.length === 0) {
    return { empty: true, summary: [], recent: [] };
  }
  return {
    empty: false,
    summary: buildSummary(executions),
    recent: buildRecent(executions, input.personNameOf),
  };
}
