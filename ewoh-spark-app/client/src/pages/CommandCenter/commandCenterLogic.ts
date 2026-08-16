/* commandCenterLogic.ts — 指挥中心数据型页面纯逻辑（NO-13ae / ADR-080，§17/§33）。
 *
 * KPI 派生（OverviewStats → 六项，缺省 0 显式不猜）、事件副标题与时间
 * 戳格式化（createdAt 缺失显式空串，不伪造时间）。纯函数零网络，供
 * CommandCenterView 与 node 测试消费。
 */
import type { OverviewStats, EventInfo } from '@shared/api.interface';

export interface CommandCenterKpi {
  key: 'deviceTotal' | 'deviceOnline' | 'eventOpen' | 'eventCritical' | 'avgLoad' | 'workerCount';
  label: string;
  value: number;
}

export const COMMAND_CENTER_KPI_LABELS: Record<CommandCenterKpi['key'], string> = {
  deviceTotal: '设备总数',
  deviceOnline: '在线设备',
  eventOpen: '未关闭事件',
  eventCritical: '重大事件',
  avgLoad: '平均负荷',
  workerCount: '作业人员',
};

const KPI_KEYS: CommandCenterKpi['key'][] = [
  'deviceTotal',
  'deviceOnline',
  'eventOpen',
  'eventCritical',
  'avgLoad',
  'workerCount',
];

export function buildCommandCenterKpis(
  overview: OverviewStats | null | undefined,
): CommandCenterKpi[] {
  return KPI_KEYS.map((key) => ({
    key,
    label: COMMAND_CENTER_KPI_LABELS[key],
    value: overview?.[key] ?? 0,
  }));
}

/** createdAt 缺失 → 显式空串（§33 不伪造时间）；存在 → 本地化展示。 */
export function formatEventTimestamp(createdAt?: string | null): string {
  return createdAt ? new Date(createdAt).toLocaleString() : '';
}

/** 设备 · 严重度 · 状态 副标题（原始事实透出；字段缺省由契约保证）。 */
export function buildEventSubtitle(event: EventInfo): string {
  return `${event.deviceId} · ${event.severity} · ${event.status}`;
}
