/**
 * devicesLogic.ts — Devices 数据页纯逻辑层（ADR-083，§17/§33）。
 *
 * 从 Devices.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 */
import type { DeviceInfo, DeviceSearchQuery } from '@shared/api.interface';

// ── 类型 ─────────────────────────────────────────────────────────────────

export type OnlineFilter = 'all' | 'online' | 'offline';
export type SourceFilter =
  | 'all'
  | 'real'
  | 'simulated'
  | 'controlled_test'
  | 'replayed'
  | 'stale'
  | 'offline';
export type OrderBy =
  | 'batteryDesc'
  | 'battery'
  | 'lastTelemetryAtDesc'
  | 'deviceId'
  | 'deviceIdDesc';

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 电量颜色：>50% 绿、>20% 黄、≤20% 红。 */
export function batteryColor(pct: number): string {
  return pct > 50 ? '#22c55e' : pct > 20 ? '#eab308' : '#ef4444';
}

/** 数据过期判定：超过 60s 未成功更新即视为过期。 */
export function isDataStale(dataUpdatedAt: number, staleMs = 60000): boolean {
  return dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > staleMs;
}

/** 从搜索参数构建 DeviceSearchQuery（过滤空值）。 */
export function buildDeviceSearchQuery(params: {
  keyword?: string;
  onlineFilter?: OnlineFilter;
  batteryMin?: string;
  batteryMax?: string;
  sourceFilter?: SourceFilter;
  orderby: OrderBy;
}): DeviceSearchQuery {
  const q: DeviceSearchQuery = { orderby: params.orderby };
  if (params.keyword?.trim()) q.keyword = params.keyword.trim();
  if (params.onlineFilter && params.onlineFilter !== 'all') {
    q.online = params.onlineFilter === 'online';
  }
  if (params.batteryMin !== undefined && params.batteryMin !== '') {
    q.batteryMin = Number(params.batteryMin);
  }
  if (params.batteryMax !== undefined && params.batteryMax !== '') {
    q.batteryMax = Number(params.batteryMax);
  }
  if (params.sourceFilter && params.sourceFilter !== 'all') {
    q.sourceType = params.sourceFilter;
  }
  return q;
}

/** 设备电量图表数据转换。 */
export function buildBatteryChartData(
  devices: DeviceInfo[],
): Array<{ name: string; battery: number; online: boolean }> {
  return devices.map((d) => ({
    name: d.deviceId,
    battery: d.batteryPct,
    online: d.online,
  }));
}

/** 空间实体名称查找表构建。 */
export function buildEntityNameMap(
  entities: Array<{ entityId: string; id: string; name: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) {
    m.set(e.entityId, e.name);
    m.set(e.id, e.name);
  }
  return m;
}

/** 数据源标签中文映射。 */
export const SOURCE_LABELS: Record<string, string> = {
  real: '真实',
  simulated: '仿真',
  controlled_test: '受控测试',
  replayed: '回放',
  stale: '过期',
  offline: '离线',
};
