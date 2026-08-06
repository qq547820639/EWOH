import type { WorkbenchListResult } from '../../api/operations';

/**
 * 角色工作台「数据页状态」领域建模（纯函数，node 可测，无 React/DOM）。
 *
 * 每个工作台列表必须能区分：首次加载 loading、后台刷新 refreshing、空结果 empty、
 * 无业务数据 no_data、未配置 not_configured、无权限 permission_denied、数据源错误
 * source_unavailable、过期 stale、部分模块失败 partial、请求失败 error。
 *
 * 这些状态全部由后端 getWorkbench() 返回的 availability 标记对象（status 字段）以及
 * getWorkbenchList() 返回的 status 字段派生，绝不硬编码。列表自身的 loading / error /
 * refreshing 则由 @tanstack/react-query 的字段派生。
 */

export type ApiMetricStatus =
  | 'no_data'
  | 'not_configured'
  | 'permission_denied'
  | 'source_unavailable'
  | 'stale';

/** 后端 getWorkbench() 中「无可靠数据源」指标的 availability 对象形状。 */
export interface MetricAvailability {
  value: unknown;
  status: ApiMetricStatus;
  calculatedAt: string;
  dataRange: unknown;
  source: string;
}

const METRIC_STATUS_SET: ReadonlySet<string> = new Set<ApiMetricStatus>([
  'no_data',
  'not_configured',
  'permission_denied',
  'source_unavailable',
  'stale',
]);

/** 判断一个 workbench data 值是否为后端 availability 标记对象（由 status 字段派生）。 */
export function isMetricAvailability(
  value: unknown,
): value is MetricAvailability {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'string' && METRIC_STATUS_SET.has(status);
}

/** 工作台列表的完整数据页状态（含正常渲染 ok）。 */
export type WorkbenchListState =
  | 'loading'
  | 'refreshing'
  | 'ok'
  | 'empty'
  | 'no_data'
  | 'not_configured'
  | 'permission_denied'
  | 'source_unavailable'
  | 'stale'
  | 'partial'
  | 'error';

export interface WorkbenchListStateInput {
  /** react-query：首次加载且无数据。 */
  isLoading: boolean;
  /** react-query：请求失败。 */
  isError: boolean;
  /** react-query：后台刷新（stale-while-revalidate）。 */
  isFetching: boolean;
  /** 当前是否已有数据（用于区分首载与后台刷新）。 */
  hasData: boolean;
  /** 后端返回的列表记录总数。 */
  total: number;
  /** 后端 getWorkbenchList() 返回的 status（'ok' 或其它）。 */
  apiStatus?: string;
  /** 对象型列表在后端 workbench data 中的 availability 标记（若存在）。 */
  availability?: MetricAvailability;
}

/**
 * 把查询状态 + 后端状态字段统一归约为一个确定的数据页状态。优先级：首载 loading →
 * 请求失败 error → availability 标记（no_data / not_configured / permission_denied /
 * source_unavailable / stale）→ 非 ok 的 apiStatus → 空 empty → 后台刷新 refreshing →
 * 正常 ok。
 */
export function resolveWorkbenchListState(
  input: WorkbenchListStateInput,
): WorkbenchListState {
  if (input.isLoading) return 'loading';
  if (input.isError) return 'error';
  if (input.availability) return input.availability.status;
  if (input.apiStatus && input.apiStatus !== 'ok') return 'error';
  if (input.total === 0) return 'empty';
  if (input.isFetching) return 'refreshing';
  return 'ok';
}

const STATE_TITLE: Record<WorkbenchListState, string> = {
  loading: '正在加载',
  refreshing: '正在刷新',
  ok: '',
  empty: '暂无数据',
  no_data: '暂无业务数据',
  not_configured: '未配置数据源',
  permission_denied: '无查看权限',
  source_unavailable: '数据源暂不可用',
  stale: '数据已过期',
  partial: '部分数据缺失',
  error: '加载失败',
};

const STATE_DESCRIPTION: Partial<Record<WorkbenchListState, string>> = {
  refreshing: '正在后台获取最新数据，列表内容保持不变。',
  empty: '当前筛选条件下没有可展示的记录。',
  no_data: '当前角色在该范围内没有可展示的业务数据。',
  not_configured: '该指标尚未接入数据源，暂时无法展示。',
  permission_denied: '当前账号缺少查看该数据的权限，如需访问请联系管理员。',
  source_unavailable: '数据源暂时不可用，可能是服务异常或未配置组织范围。',
  stale: '正在展示上次成功获取的数据，可能不是最新，请刷新后重试。',
  partial: '部分数据模块暂时不可用，其余功能可正常使用。',
  error: '请求失败，请稍后重试。',
};

/** 数据页状态的中文标题。 */
export function workbenchListStateTitle(state: WorkbenchListState): string {
  return STATE_TITLE[state];
}

/** 数据页状态的中文说明（供无障碍 aria-description 与提示条使用）。 */
export function workbenchListStateDescription(
  state: WorkbenchListState,
): string {
  return STATE_DESCRIPTION[state] ?? '';
}

/** 仅当状态为「无业务数据 / 未配置 / 无权限 / 数据源错误 / 过期」时才视为非正常可用状态。 */
export function isBlockingListState(state: WorkbenchListState): boolean {
  return (
    state === 'no_data' ||
    state === 'not_configured' ||
    state === 'permission_denied' ||
    state === 'source_unavailable' ||
    state === 'stale' ||
    state === 'error'
  );
}

/** 从后端 workbench data 中收集所有 availability 标记的状态（用于页面级健康度）。 */
export function collectAvailabilityStats(
  data: Record<string, unknown>,
): ApiMetricStatus[] {
  const statuses: ApiMetricStatus[] = [];
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (isMetricAvailability(value)) statuses.push(value.status);
  }
  return statuses;
}

/** 页面级数据健康度：全靠 availability 派生，绝不硬编码。 */
export type PageDataHealth = 'ok' | 'partial' | 'degraded';

/**
 * 页面级健康度归约：
 * - 没有任何 availability 标记 → ok；
 * - 含 source_unavailable（数据源错误）→ degraded（服务降级）；
 * - 其余（no_data / not_configured / permission_denied / stale）→ partial（部分数据缺失）。
 */
export function resolvePageHealth(
  statuses: ApiMetricStatus[],
): PageDataHealth {
  if (statuses.length === 0) return 'ok';
  if (statuses.includes('source_unavailable')) return 'degraded';
  return 'partial';
}

/** 从 getWorkbenchList 结果中读取后端 dataFreshness（无则返回 null）。 */
export function listDataFreshness(
  result?: WorkbenchListResult,
): string | null {
  return result?.dataFreshness ?? null;
}