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

// ── NO-62c：方案过期诊断（与后端 409 体同一形状）──────────────────────────

/** 差异项（后端 `PlanStalenessReport.changes` 的客户端镜像）。 */
export interface StalenessChangeView {
  kind: 'entity_version' | 'reservation';
  entityKey: string;
  entityType: string;
  entityId: string;
  change: 'added' | 'removed' | 'changed';
  selfInflicted: boolean;
  label: string;
  /**
   * NO-64a：变化性质（与后端闸门**同一分档**）。
   * - `content`：事实变化 → 必须重新排程；
   * - `blocked_evidence`：本方案依赖的资源证据已过期 → 必须重新采集后重排；
   * - `evidence`：仅证据老化（与方案无关）→ 不阻断审批。
   */
  severity?: 'content' | 'blocked_evidence' | 'evidence';
  /** 该实体是否被本方案依赖。 */
  usedByPlan?: boolean;
}

export interface StalenessReportView {
  snapshotVersion: string;
  snapshotFound: boolean;
  stale: boolean;
  changes: StalenessChangeView[];
  externalChangeCount?: number;
  selfInflictedCount?: number;
  /** NO-64a：事实变化数（阻断）。 */
  contentChangeCount?: number;
  /** NO-64a：仅证据老化数（不阻断）。 */
  evidenceAgedCount?: number;
  /** NO-64a：方案依赖但证据已过期的实体数（阻断）。 */
  blockedEvidenceCount?: number;
  /** NO-64a：阻断原因。 */
  reason?: 'CONTENT_CHANGED' | 'EVIDENCE_STALE' | null;
  summary: string;
  checkedAt: string;
}

function isStalenessReport(value: unknown): value is StalenessReportView {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<StalenessReportView>;
  return typeof report.stale === 'boolean' && Array.isArray(report.changes);
}

/**
 * 从审批 409（或 `GET /plans/:id/staleness` 响应）里取出过期诊断。
 *
 * 诚实边界：拿不到结构化诊断时返回 null——**不编造**一句"状态已变化"来假装有诊断
 * （页面据此降级成"后端未提供差异明细"的显式文案，原则 7）。
 */
export function extractStalenessReport(payload: unknown): StalenessReportView | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { staleness?: unknown; data?: unknown; error?: unknown };
  if (isStalenessReport(body.staleness)) return body.staleness;
  // 统一错误信封（全局异常过滤器）：`{ error: { code, message, planStaleness } }`
  const envelope = body.error as { planStaleness?: unknown } | undefined;
  if (envelope && isStalenessReport(envelope.planStaleness)) return envelope.planStaleness;
  if (isStalenessReport(body.data)) return body.data;
  return isStalenessReport(payload) ? (payload as StalenessReportView) : null;
}

/** 从 axios 错误对象里提取诊断（兼容 data.staleness / data 直接是报告两种形状）。 */
export function stalenessFromError(err: unknown): StalenessReportView | null {
  const e = err as { response?: { data?: unknown } };
  return extractStalenessReport(e?.response?.data);
}

/**
 * 差异项排序 + 截断：**外部变化优先**（用户要先看不是自己造成的那部分），
 * 其次按实体键稳定排序（同一份诊断每次渲染顺序一致）。
 */
export function orderStalenessChanges(
  report: StalenessReportView,
  max = 8,
): { shown: StalenessChangeView[]; hiddenCount: number } {
  const sorted = [...report.changes].sort((left, right) => {
    if (left.selfInflicted !== right.selfInflicted) return left.selfInflicted ? 1 : -1;
    return left.entityKey < right.entityKey ? -1 : left.entityKey > right.entityKey ? 1 : 0;
  });
  return { shown: sorted.slice(0, max), hiddenCount: Math.max(0, sorted.length - max) };
}
