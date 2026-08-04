import { navGroups } from './navigation';

/**
 * 全局应用外壳（UX-006）的纯逻辑层。
 * 负责组织/工厂/产线/环境上下文、版本、数据新鲜度、最近访问、收藏视图的
 * localStorage 读写与解析。所有函数保持纯函数、可注入存储，便于单元测试。
 *
 * 说明：当前尚无真实后端契约，组织/工厂/产线/环境使用可配置的本地默认值，
 * 并在 UI 上明确标注「演示/待接入真数据」，不伪造后端数据。
 */

export type EwohEnvironment = 'production' | 'staging' | 'development';

export interface AppContext {
  orgId: string;
  factoryId: string;
  lineId: string;
  env: EwohEnvironment;
  /** 最近一次成功拉取数据的 ISO 时间；null 表示暂无数据（待接入）。 */
  lastDataUpdatedAt: string | null;
}

export interface AppContextOption {
  id: string;
  label: string;
}

export const APP_VERSION = '0.6.0-rc4';

export const APP_CONTEXT_STORAGE_KEY = 'ewoh.app-context';
export const RECENT_ACCESS_STORAGE_KEY = 'ewoh.recent-access';
export const FAVORITES_STORAGE_KEY = 'ewoh.favorites';
export const MAX_RECENT = 8;
export const MAX_FAVORITES = 20;

/** 组织/工厂/产线为演示用的可配置本地默认值（待接入真实后端）。 */
export const DEFAULT_APP_CONTEXT: AppContext = {
  orgId: 'default-factory',
  factoryId: 'main-factory',
  lineId: 'line-1',
  env: 'production',
  lastDataUpdatedAt: null,
};

export const ORG_OPTIONS: AppContextOption[] = [
  { id: 'default-factory', label: '默认工厂' },
  { id: 'org-2', label: '第二工厂' },
];

export const FACTORY_OPTIONS: AppContextOption[] = [
  { id: 'main-factory', label: '主产线' },
  { id: 'factory-2', label: '二号线' },
];

export const LINE_OPTIONS: AppContextOption[] = [
  { id: 'line-1', label: '产线 1' },
  { id: 'line-2', label: '产线 2' },
  { id: 'line-3', label: '产线 3' },
];

export const ENV_OPTIONS: Array<{ id: EwohEnvironment; label: string }> = [
  { id: 'production', label: '生产' },
  { id: 'staging', label: '预发布' },
  { id: 'development', label: '开发' },
];

export const ENV_LABELS: Record<EwohEnvironment, string> = {
  production: '生产',
  staging: '预发布',
  development: '开发',
};

/** 最小化的 localStorage 接口，便于测试注入内存实现。 */
export interface AppContextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 读取应用上下文，缺失/损坏时回退到默认值。 */
export function readAppContext(storage: AppContextStorage = window.localStorage): AppContext {
  const raw = storage.getItem(APP_CONTEXT_STORAGE_KEY);
  const parsed = parseJson<Partial<AppContext>>(raw, {});
  return { ...DEFAULT_APP_CONTEXT, ...parsed };
}

/** 持久化应用上下文到 localStorage。 */
export function writeAppContext(
  context: AppContext,
  storage: AppContextStorage = window.localStorage,
): void {
  storage.setItem(APP_CONTEXT_STORAGE_KEY, JSON.stringify(context));
}

export interface RecentEntry {
  path: string;
  label: string;
  at: string;
}

/** 读取最近访问记录（按时间倒序）。 */
export function readRecentAccess(
  storage: AppContextStorage = window.localStorage,
): RecentEntry[] {
  return parseJson<RecentEntry[]>(storage.getItem(RECENT_ACCESS_STORAGE_KEY), []);
}

/**
 * 记录一次路由访问：去重（同路径保留最新）、置顶、截断到 MAX_RECENT。
 * 返回更新后的列表并持久化。
 */
export function recordRecentAccess(
  path: string,
  label: string,
  storage: AppContextStorage = window.localStorage,
): RecentEntry[] {
  const current = readRecentAccess(storage).filter((entry) => entry.path !== path);
  const next = [{ path, label, at: new Date().toISOString() }, ...current].slice(0, MAX_RECENT);
  storage.setItem(RECENT_ACCESS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** 清空最近访问记录。 */
export function clearRecentAccess(
  storage: AppContextStorage = window.localStorage,
): void {
  storage.removeItem(RECENT_ACCESS_STORAGE_KEY);
}

/** 读取收藏视图路径列表。 */
export function readFavorites(storage: AppContextStorage = window.localStorage): string[] {
  return parseJson<string[]>(storage.getItem(FAVORITES_STORAGE_KEY), []);
}

export function isFavorite(
  path: string,
  storage: AppContextStorage = window.localStorage,
): boolean {
  return readFavorites(storage).includes(path);
}

/** 切换当前路由的收藏状态，返回最新列表与是否已收藏。 */
export function toggleFavorite(
  path: string,
  storage: AppContextStorage = window.localStorage,
): { favorites: string[]; isFavorite: boolean } {
  const current = readFavorites(storage);
  const exists = current.includes(path);
  const next = exists
    ? current.filter((p) => p !== path)
    : [...current, path].slice(0, MAX_FAVORITES);
  storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
  return { favorites: next, isFavorite: !exists };
}

export interface BreadcrumbCrumb {
  label: string;
  to?: string;
}

/**
 * 基于 navGroups 反向映射当前路由：返回「分组名 + 页面名」层级。
 * 未匹配到路由时回退为「首页」。
 */
export function resolveBreadcrumb(
  path: string,
  groups: Array<{ label: string; items: Array<{ to: string; label: string }> }> = navGroups,
): BreadcrumbCrumb[] {
  let groupLabel: string | null = null;
  let itemLabel: string | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.to === path) {
        groupLabel = group.label;
        itemLabel = item.label;
        break;
      }
    }
    if (groupLabel) break;
  }
  if (!groupLabel || !itemLabel) return [{ label: '首页', to: '/command-center' }];
  return [{ label: groupLabel }, { label: itemLabel, to: path }];
}

/** 返回路由对应的导航项 label，未匹配时返回 null。 */
export function resolveNavLabel(
  path: string,
  groups: Array<{ items: Array<{ to: string; label: string }> }> = navGroups,
): string | null {
  for (const group of groups) {
    for (const item of group.items) {
      if (item.to === path) return item.label;
    }
  }
  return null;
}

/** 格式化数据新鲜度（"刚刚 / N 分钟前 / 本地时间"）。 */
export function formatDataFreshness(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '未知';
  const elapsedMs = Date.now() - then;
  if (elapsedMs < 60_000) return '刚刚';
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)} 分钟前`;
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}