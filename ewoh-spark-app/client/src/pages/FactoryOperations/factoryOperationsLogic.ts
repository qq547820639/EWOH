import type { EventInfo, OverviewStats } from '@shared/api.interface';
import type { SchedulingPlanV2 } from '@shared/scheduler';

export interface FactoryOperationsKpi {
  key: keyof OverviewStats;
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'warning' | 'critical';
}

export interface AttentionItem {
  id: string;
  /** event=现场异常 / plan=调度决策 / system=系统审计记录（非现场异常）。 */
  kind: 'event' | 'plan' | 'system';
  title: string;
  detail: string;
  tone: 'warning' | 'critical' | 'neutral';
  href: string;
  actionLabel: string;
}

export const FACTORY_DATA_STALE_AFTER_MS = 60_000;

const KPI_LABELS: Record<keyof OverviewStats, string> = {
  deviceTotal: '接入设备',
  deviceOnline: '在线设备',
  eventOpen: '待确认事件',
  eventCritical: '中高风险记录',
  avgLoad: '近1小时平均负荷',
  workerCount: '绑定人员',
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function buildFactoryOperationsKpis(
  overview: OverviewStats | null | undefined,
  isCurrent = true,
): FactoryOperationsKpi[] {
  const valueFor = (key: keyof OverviewStats): number | undefined => {
    const value = overview?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const eventCritical = valueFor('eventCritical');
  const eventOpen = valueFor('eventOpen');
  const deviceOnline = valueFor('deviceOnline');
  const deviceTotal = valueFor('deviceTotal');
  const avgLoad = valueFor('avgLoad');
  const workerCount = valueFor('workerCount');
  const display = (value: number | undefined) => value === undefined ? '—' : formatNumber(value);
  return [
    {
      key: 'eventCritical',
      label: KPI_LABELS.eventCritical,
      value: display(eventCritical),
      detail: '平台累计记录，含已关闭事件',
      tone: isCurrent && eventCritical !== undefined && eventCritical > 0 ? 'critical' : 'neutral',
    },
    {
      key: 'eventOpen',
      label: KPI_LABELS.eventOpen,
      value: display(eventOpen),
      detail: '仅待确认状态，不含处置中事件',
      tone: isCurrent && eventOpen !== undefined && eventOpen > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'deviceOnline',
      label: KPI_LABELS.deviceOnline,
      value: `${display(deviceOnline)} / ${display(deviceTotal)}`,
      detail: '平台登记状态，现场心跳需在地图核验',
      tone: isCurrent && deviceOnline !== undefined && deviceTotal !== undefined && deviceTotal > 0
        ? deviceOnline < deviceTotal ? 'warning' : 'positive'
        : 'neutral',
    },
    {
      key: 'avgLoad',
      label: KPI_LABELS.avgLoad,
      value: avgLoad === undefined ? '—' : `${formatNumber(avgLoad * 100)}%`,
      detail: '未提供样本数，0 不代表已确认零负荷',
      tone: isCurrent && avgLoad !== undefined && avgLoad >= 0.8 ? 'warning' : 'neutral',
    },
    {
      key: 'workerCount',
      label: KPI_LABELS.workerCount,
      value: display(workerCount),
      detail: '按设备绑定姓名去重，非在岗人数',
      tone: 'neutral',
    },
  ];
}

function severityTone(severity: string): AttentionItem['tone'] {
  return ['critical', 'high', 'L1', 'L2'].includes(severity) ? 'critical' : 'warning';
}

function severityLabel(severity: string): string {
  const labels: Record<string, string> = {
    critical: '严重',
    high: '高',
    medium: '中',
    low: '低',
    L1: '严重',
    L2: '高',
    L3: '中',
  };
  return labels[severity] ?? severity;
}

function eventStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: '待确认',
    acknowledged: '已确认',
    processing: '处置中',
    closed: '已关闭',
    resolved: '已解决',
  };
  return labels[status] ?? status;
}

function planStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: '待审批',
    shadow: '影子评估，尚未授权执行',
    approved: '已审批，待派工',
    dispatched: '已派工',
    executing: '执行中',
  };
  return labels[status] ?? status;
}

function sourceLabel(sourceType: string | undefined): string {
  const labels: Record<string, string> = {
    real: '真实来源',
    controlled_test: '受控测试',
    simulated: '模拟数据',
    replayed: '回放数据',
    stale: '陈旧数据',
    offline: '离线数据',
    // 平台内部台账来源（2026-09-11 补充）：学习/仿真的审计事件有明确身份，
    // 不应落入"来源未提供"的兜底文案。
    learning: '学习台账',
    simulation: '仿真记录',
    system: '系统事件',
  };
  return sourceType && labels[sourceType] ? labels[sourceType] : '来源未提供，待核验';
}

function severityPriority(severity: string): number {
  const priority: Record<string, number> = { critical: 0, L1: 0, high: 1, L2: 1, medium: 2, L3: 2, low: 3 };
  return priority[severity] ?? 4;
}

/**
 * 系统审计事件判定：学习/仿真/系统来源的台账事件（结果标注、仿真运行等）
 * 不是现场异常。混入"现在需要处理"会让人把审计记录当成待处置风险
 * （状态混淆），因此单独分组、单独标签、不占用异常名额。
 * 判定双路：sourceType 显式来源优先，eventType 模式兜底（存量行可能缺 sourceType 投影）。
 */
export function isSystemAuditEvent(event: EventInfo): boolean {
  if (event.sourceType && ['learning', 'simulation', 'system'].includes(event.sourceType)) return true;
  const eventType = event.eventType || '';
  return eventType === 'OutcomeAnnotationRecorded' || eventType.startsWith('SimulationRun');
}

export function buildAttentionItems(
  events: EventInfo[] | undefined,
  plans: SchedulingPlanV2[] | undefined,
): AttentionItem[] {
  const fieldEvents = (events ?? []).filter((event) => !isSystemAuditEvent(event));
  const systemEvents = (events ?? []).filter(isSystemAuditEvent);
  const eventItems = fieldEvents
    .filter((event) => event.status !== 'closed' && event.status !== 'resolved')
    .sort((left, right) => severityPriority(left.severity) - severityPriority(right.severity))
    .map<AttentionItem>((event) => ({
      id: `event:${event.eventId || event.id}`,
      kind: 'event',
      title: event.title || event.eventCode,
      detail: `${event.deviceId || '未关联设备'} · ${severityLabel(event.severity)}风险 · ${eventStatusLabel(event.status)} · ${sourceLabel(event.sourceType)}`,
      tone: severityTone(event.severity),
      href: `/o/alert/${encodeURIComponent(event.eventId || event.id)}`,
      actionLabel: '查看异常证据与关联设备',
    }));
  const planItems = (plans ?? [])
    .filter((plan) => ['draft', 'shadow', 'approved', 'dispatched', 'executing'].includes(plan.status))
    .sort((left, right) => {
      const priority: Record<string, number> = { approved: 0, draft: 1, executing: 2, dispatched: 2, shadow: 3 };
      return priority[left.status] - priority[right.status];
    })
    .map<AttentionItem>((plan) => ({
      id: `plan:${plan.planId}`,
      kind: 'plan',
      title: plan.planName ?? `调度方案 ${plan.planId}`,
      detail: `${planStatusLabel(plan.status)} · 方案预计延期 ${formatNumber(plan.metrics.lateMinutes)} 分钟 · 快照 ${plan.snapshotVersion} · 非现场执行结果`,
      tone: plan.status === 'shadow' ? 'neutral' : plan.metrics.lateMinutes > 0 ? 'warning' : 'neutral',
      href: `/o/scheduling_plan/${encodeURIComponent(plan.planId)}`,
      actionLabel: plan.status === 'shadow' ? '查看影子方案与评估证据'
        : plan.status === 'approved' ? '查看方案并派工'
        : plan.status === 'draft' ? '查看影响与审批'
        : '查看方案与执行入口',
    }));
  // 系统记录排最后、限量展示：可追溯但不与"需要人处理的事"抢注意力。
  const systemItems = systemEvents
    .filter((event) => event.status !== 'closed' && event.status !== 'resolved')
    .sort((left, right) => severityPriority(left.severity) - severityPriority(right.severity))
    .map<AttentionItem>((event) => ({
      id: `system:${event.eventId || event.id}`,
      kind: 'system',
      title: event.title || event.eventCode,
      detail: `系统审计记录（非现场异常）· ${eventStatusLabel(event.status)} · ${sourceLabel(event.sourceType)}`,
      tone: 'neutral' as const,
      href: `/o/alert/${encodeURIComponent(event.eventId || event.id)}`,
      actionLabel: '查看台账详情',
    }));
  return [...eventItems.slice(0, 4), ...planItems.slice(0, 4), ...systemItems.slice(0, 2)];
}

export function isFactoryDataCurrent(timestamp: number | undefined, now = Date.now()): boolean {
  return Boolean(timestamp && Number.isFinite(timestamp) && timestamp <= now && now - timestamp < FACTORY_DATA_STALE_AFTER_MS);
}

export function formatFreshness(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '尚未取得平台数据';
  const fetchedAt = new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  return `最近获取于 ${fetchedAt}（北京时间）${isFactoryDataCurrent(timestamp, now) ? '' : ' · 时间异常或已超过60秒，请刷新'}`;
}
