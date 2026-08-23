/**
 * schedulingLogic.ts — Scheduling 数据页纯逻辑层（ADR-082，§17/§33）。
 *
 * 从 Scheduling.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 * 纯函数 + 常量 + 类型；视图层 SchedulingView.tsx 消费。
 */
import type { PlanStatus, SchedulingPlanV2 } from '@shared/api.interface';

// ── 类型 ─────────────────────────────────────────────────────────────────

export type StatusFilter = 'all' | 'pending' | 'approved';

export interface SchedulingRun {
  runId: string;
  status: string;
  triggerType: string;
  createdAt: string;
  planIds: string[];
  error?: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const STATUS_FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: '全部', value: 'all' },
  { label: '待审批', value: 'pending' },
  { label: '已审批', value: 'approved' },
];

export const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: '手动',
  TASK_CREATED: '任务创建',
  TASK_UPDATED: '任务更新',
  PERSON_UNAVAILABLE: '人员不可用',
  DEVICE_OFFLINE: '设备离线',
  DEVICE_LOW_BATTERY: '设备低电量',
  BOTTLENECK_DETECTED: '瓶颈检测',
  DEADLINE_AT_RISK: '交期风险',
  SAFETY_EVENT: '安全事件',
  ZONE_RESTRICTED: '区域受限',
};

// ── 纯函数 ───────────────────────────────────────────────────────────────

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function isPendingStatus(status: PlanStatus): boolean {
  return status === 'draft' || status === 'shadow';
}

export function isPlanStaleError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  const status = e.response?.status;
  const dataMsg = (e.response?.data as { message?: string } | undefined)?.message;
  const msg = dataMsg ?? e.message ?? '';
  return status === 409 && msg.includes('PLAN_STALE');
}

export function buildPlanSubtitle(row: SchedulingPlanV2): string {
  const trigger = TRIGGER_LABELS[row.trigger?.type] ?? row.trigger?.type ?? '—';
  return `v${row.version} · ${trigger} · ${formatTime(row.createdAt)}`;
}

export function buildMetricsSummary(row: SchedulingPlanV2): string {
  const m = row.metrics;
  const late = m?.lateMinutes != null ? m.lateMinutes.toFixed(0) : '0';
  const walk = m?.walkingMeters != null ? m.walkingMeters.toFixed(0) : '0';
  const wait = m?.stationWaitMinutes != null ? m.stationWaitMinutes.toFixed(0) : '0';
  const load = m?.maxWorkload != null ? (m.maxWorkload * 100).toFixed(0) : '0';
  return `延期 ${late}min · 移动 ${walk}m · 等待 ${wait}min · 负荷 ${load}%`;
}

export function filterPlansByStatus(
  plans: SchedulingPlanV2[],
  filter: StatusFilter,
): SchedulingPlanV2[] {
  if (filter === 'all') return plans;
  if (filter === 'pending') return plans.filter((p) => isPendingStatus(p.status));
  // 'approved' 映射到所有已过审批的状态（与 Scheduling.tsx 语义一致）。
  return plans.filter((p) =>
    ['approved', 'dispatched', 'executing', 'completed'].includes(p.status),
  );
}

export function aggregateMutationErrors(errors: unknown[]): string | null {
  const messages = errors
    .filter((e): e is Error => e instanceof Error)
    .map((e) => e.message);
  return messages.length > 0 ? messages.join('；') : null;
}

export function buildRunSubtitle(run: SchedulingRun): string {
  const trigger = TRIGGER_LABELS[run.triggerType] ?? run.triggerType;
  return `${trigger} · ${formatTime(run.createdAt)} · 方案 ${run.planIds.length} 个`;
}
