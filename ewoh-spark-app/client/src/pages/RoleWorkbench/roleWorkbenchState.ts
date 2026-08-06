import type { RoleWorkbenchRole } from '../../api/operations';
import type { ListDefinition } from './roleSchema';

/**
 * 角色工作台「页面查询状态」领域建模（纯函数，node 可测，无 React/DOM）。
 *
 * RoleWorkbench 的每个列表查询状态（筛选/排序/页码）由 URL search params 派生，
 * 刷新/复制链接/前进后退均可恢复。本模块把「URL ⇄ 查询状态」的双向映射、以及
 * 服务端视图键、旧版 localStorage 键迁移的纯逻辑收敛于此，便于单测与复用。
 */

/** 旧版 localStorage 视图键前缀（用于一次性迁移）。 */
export const LEGACY_VIEW_PREFIX = 'ewoh.roleWorkbench.view.';

/** 服务端分页的每页大小（服务端 clamp 上限 100），列表查询的领域常量。 */
export const PAGE_SIZE = 50;
/** 行虚拟化：固定行高估计 + 上下 overscan，避免一次性渲染 10k+ 行。 */
export const ROW_HEIGHT = 40;
export const OVERSCAN = 10;

export const ROLES: Array<{ key: RoleWorkbenchRole; label: string }> = [
  { key: 'operator', label: '操作员' },
  { key: 'team_lead', label: '班组长' },
  { key: 'quality', label: '质检' },
  { key: 'equipment', label: '设备' },
  { key: 'manager', label: '管理者' },
];

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/** 单个列表的当前查询状态（筛选/排序/页码）。 */
export interface ListState {
  filter: string;
  sort?: SortState;
  page: number;
}

/** 没有任何查询参数时的默认列表状态。 */
export function defaultListState(): ListState {
  return { filter: '', sort: undefined, page: 1 };
}

/** 服务端视图键（跨设备 / 共享）。 */
export function serverViewKey(role: RoleWorkbenchRole, listKey: string): string {
  return `${role}.${listKey}`;
}

/** 从旧版 localStorage 键中解析出 role 与 listKey。 */
export function parseLegacyViewKey(
  key: string,
): { role: RoleWorkbenchRole; listKey: string } | null {
  if (!key.startsWith(LEGACY_VIEW_PREFIX)) return null;
  const rest = key.slice(LEGACY_VIEW_PREFIX.length);
  for (const role of ROLES) {
    const prefix = `${role.key}.`;
    if (rest.startsWith(prefix)) {
      const listKey = rest.slice(prefix.length);
      if (listKey) return { role: role.key, listKey };
    }
  }
  return null;
}

/** 从 URL search params 初始化每个列表的查询状态。 */
export function readListStates(
  searchParams: URLSearchParams,
  lists: ListDefinition[],
): Record<string, ListState> {
  const out: Record<string, ListState> = {};
  for (const list of lists) {
    const filter = searchParams.get(`${list.key}.filter`) ?? '';
    const sortKey = searchParams.get(`${list.key}.sort`);
    const dirRaw = searchParams.get(`${list.key}.dir`);
    const pageRaw = Number(searchParams.get(`${list.key}.page`));
    out[list.key] = {
      filter,
      sort: sortKey
        ? { key: sortKey, dir: dirRaw === 'desc' ? 'desc' : 'asc' }
        : undefined,
      page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * URL ⇄ 查询状态的写映射（纯函数，返回新 URLSearchParams，不修改入参）
 * ------------------------------------------------------------------ */

/** 设置单个列表的筛选并重置页码。 */
export function buildFilterParams(
  prev: URLSearchParams,
  listKey: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value) next.set(`${listKey}.filter`, value);
  else next.delete(`${listKey}.filter`);
  next.set(`${listKey}.page`, '1');
  return next;
}

/** 切换单个列表的排序（同列翻转方向，异列重置为 asc）并重置页码。 */
export function buildSortParams(
  prev: URLSearchParams,
  listKey: string,
  columnKey: string,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  const current = next.get(`${listKey}.sort`);
  const dir = next.get(`${listKey}.dir`);
  if (current === columnKey) {
    next.set(`${listKey}.dir`, dir === 'asc' ? 'desc' : 'asc');
  } else {
    next.set(`${listKey}.sort`, columnKey);
    next.set(`${listKey}.dir`, 'asc');
  }
  next.set(`${listKey}.page`, '1');
  return next;
}

/** 设置单个列表的页码。 */
export function buildPageParams(
  prev: URLSearchParams,
  listKey: string,
  page: number,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.set(`${listKey}.page`, String(page));
  return next;
}

/** 切换到指定角色（保留其它查询参数）。 */
export function buildRoleParams(
  prev: URLSearchParams,
  next: RoleWorkbenchRole,
): URLSearchParams {
  const params = new URLSearchParams(prev);
  params.set('role', next);
  return params;
}

/** 从 URL 读取当前「已打开的已保存视图」键（无则返回 null）。 */
export function readOpenedView(searchParams: URLSearchParams): string | null {
  const view = searchParams.get('view');
  return view && view.length > 0 ? view : null;
}

/** 打开/应用一个已保存视图：记录 `view` 参数（保留其它查询参数）。 */
export function buildOpenViewParams(
  prev: URLSearchParams,
  viewKey: string,
): URLSearchParams {
  const params = new URLSearchParams(prev);
  params.set('view', viewKey);
  return params;
}

/** 清除所有列表的筛选/排序/页码，并取消已打开的视图（保留 role 与其它参数）。 */
export function buildClearFiltersParams(
  prev: URLSearchParams,
  lists: ListDefinition[],
): URLSearchParams {
  const params = new URLSearchParams(prev);
  params.delete('view');
  for (const list of lists) {
    params.delete(`${list.key}.filter`);
    params.delete(`${list.key}.sort`);
    params.delete(`${list.key}.dir`);
    params.delete(`${list.key}.page`);
  }
  return params;
}