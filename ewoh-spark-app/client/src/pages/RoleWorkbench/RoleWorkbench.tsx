import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  RefreshCw,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import {
  createWorkbenchExport,
  deleteWorkbenchView,
  getRoleWorkbench,
  getWorkbenchExportTask,
  getWorkbenchList,
  listWorkbenchViews,
  saveWorkbenchView,
  type RoleWorkbenchRole,
  type WorkbenchExportStatus,
  type WorkbenchView,
} from '../../api/operations';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import QueryState from '../../components/QueryState';
import ErrorState from '../../components/ErrorState';
import {
  formatValue,
  getRoleSchema,
  type ColumnDefinition,
  type ListDefinition,
} from './roleSchema';
import {
  canUseWorkbenchDebug,
  resolveAuthorizedWorkbenchRoles,
  resolveDefaultWorkbenchRole,
} from './workbenchAccess';
import {
  parseSavedView,
  resolveRowPath,
  stableRowId,
  type SavedView,
} from './workbenchListLogic';
import {
  createWorkbenchScanner,
  inferInputMode,
  matchShortcut,
  mergeScannedValue,
  touchTargetSize,
  type WorkbenchInputMode,
} from './workbenchInput';

const ROLES: Array<{ key: RoleWorkbenchRole; label: string }> = [
  { key: 'operator', label: '操作员' },
  { key: 'team_lead', label: '班组长' },
  { key: 'quality', label: '质检' },
  { key: 'equipment', label: '设备' },
  { key: 'manager', label: '管理者' },
];

/** 服务端分页的每页大小（服务端 clamp 上限 100）。 */
const PAGE_SIZE = 50;
/** 行虚拟化：固定行高估计 + 上下 overscan，避免一次性渲染 10k+ 行。 */
const ROW_HEIGHT = 40;
const OVERSCAN = 10;

/** 旧版 localStorage 视图键前缀（用于一次性迁移）。 */
const LEGACY_VIEW_PREFIX = 'ewoh.roleWorkbench.view.';

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/** 单个列表的当前查询状态（筛选/排序/页码）。 */
interface ListState {
  filter: string;
  sort?: SortState;
  page: number;
}

/** 单个列表的导出任务状态。 */
interface ExportState {
  status: WorkbenchExportStatus | 'idle';
  progress: number;
}

/** 服务端视图键（跨设备 / 共享）。 */
function serverViewKey(role: RoleWorkbenchRole, listKey: string): string {
  return `${role}.${listKey}`;
}

/** 从旧版 localStorage 键中解析出 role 与 listKey。 */
function parseLegacyViewKey(
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
function readListStates(
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

/**
 * 行虚拟化：仅渲染视口内的行（基于滚动位置），用首尾 spacer 保持滚动高度。
 * 大表（10k+ 行）只会渲染可见的 ~O(overscan) 行 DOM。
 */
function useWindowedRange(
  total: number,
  rowHeight: number,
  containerRef: React.RefObject<HTMLDivElement | null>,
  overscan = OVERSCAN,
): { start: number; end: number; topPad: number; bottomPad: number } {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [containerRef]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return {
    start,
    end,
    topPad: Math.max(0, start * rowHeight),
    bottomPad: Math.max(0, (total - end) * rowHeight),
  };
}

/**
 * 服务端对 object 形状的列表（如设备状态分布）会归一化为 `{ key, value }` 行。
 * 这里把服务端行重新映射到 schema 列（如 status / count）以便渲染。
 */
function toSchemaRows(
  list: ListDefinition,
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!list.transform) return items;
  const [colA, colB] = list.columns;
  return items.map((item) => {
    const out = { ...item };
    if (colA && out[colA.key] === undefined && item.key !== undefined) {
      out[colA.key] = item.key;
    }
    if (colB && out[colB.key] === undefined && item.value !== undefined) {
      out[colB.key] = item.value;
    }
    return out;
  });
}

function renderCell(
  column: ColumnDefinition,
  row: Record<string, unknown>,
): React.ReactNode {
  const raw = row[column.key];
  const rawText = formatValue(column.format, raw);
  const text = column.enumMap ? (column.enumMap[String(raw)] ?? rawText) : rawText;

  if (column.link) {
    const href = column.link.valueKey
      ? `${column.link.to}/${encodeURIComponent(
          String(row[column.link.valueKey] ?? ''),
        )}`
      : column.link.to;
    return (
      <Link
        to={href}
        className="text-[hsl(221_83%_53%)] hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {text}
      </Link>
    );
  }
  return <span>{text}</span>;
}

interface WorkbenchListProps {
  list: ListDefinition;
  rows: Array<Record<string, unknown>>;
  total: number;
  loading: boolean;
  listError: boolean;
  hasMore: boolean;
  filter: string;
  sort?: SortState;
  targetSize: number;
  exportState: ExportState;
  filterInputRef: (element: HTMLInputElement | null) => void;
  onFilterFocus: () => void;
  onFilter: (value: string) => void;
  onToggleSort: (columnKey: string) => void;
  onLoadMore: () => void;
  onSaveView: () => void;
  onExport: () => void;
  onRefresh: () => void;
  error: unknown;
}

function WorkbenchList({
  list,
  rows,
  total,
  loading,
  listError,
  hasMore,
  filter,
  sort,
  targetSize,
  exportState,
  filterInputRef,
  onFilterFocus,
  onFilter,
  onToggleSort,
  onLoadMore,
  onSaveView,
  onExport,
  onRefresh,
  error,
}: WorkbenchListProps): React.ReactElement {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { start, end, topPad, bottomPad } = useWindowedRange(
    rows.length,
    ROW_HEIGHT,
    scrollRef,
  );
  const visible = rows.slice(start, end);

  const handleRowClick = (row: Record<string, unknown>) => {
    const path = resolveRowPath(list, row);
    if (path) navigate(path);
  };

  const exporting =
    exportState.status === 'queued' || exportState.status === 'running';

  return (
    <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-4 py-3">
        <ClipboardList className="size-4 text-[hsl(221_83%_53%)]" />
        <h2 className="font-semibold text-[hsl(220_14%_14%)]">{list.label}</h2>
        <span className="text-xs text-[hsl(218_10%_42%)]">
          {listError ? '加载失败' : loading ? '加载中' : `${total} 条`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="text"
            ref={filterInputRef}
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            onFocus={onFilterFocus}
            placeholder="筛选…"
            aria-label={`筛选${list.label}`}
            className="h-8 w-40 rounded-md border border-[hsl(220_14%_89%)] px-2 text-xs text-[hsl(220_14%_14%)] outline-none focus:border-[hsl(221_83%_53%)]"
            style={{ minHeight: targetSize }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            style={{ minHeight: targetSize }}
            onClick={onSaveView}
          >
            <Save className="size-3" />
            保存视图
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            style={{ minHeight: targetSize }}
            onClick={onExport}
            disabled={exporting}
          >
            <Download className="size-3" />
            导出
          </Button>
          {exportState.status === 'queued' || exportState.status === 'running' ? (
            <span role="status" className="text-xs text-[hsl(218_10%_42%)]">
              导出中 {exportState.progress}%
            </span>
          ) : exportState.status === 'succeeded' ? (
            <span role="status" className="text-xs font-medium text-green-700">
              导出完成
            </span>
          ) : exportState.status === 'failed' ? (
            <span role="status" className="text-xs font-medium text-red-600">
              导出失败
            </span>
          ) : null}
        </div>
      </div>

      {listError ? (
        <div className="p-4">
          <ErrorState
            error={error}
            errorMessage={`「${list.label}」数据加载失败，请稍后重试。`}
            onRetry={onRefresh}
            backLabel="返回工作台"
          />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[hsl(218_10%_42%)]">{list.emptyText}</p>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-[60vh] overflow-x-auto overflow-y-auto"
        >
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                {list.columns.map((column) => (
                  <th
                    key={column.key}
                    aria-sort={
                      sort?.key === column.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    className="px-4 py-2 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleSort(column.key)}
                      className="inline-flex items-center gap-1 hover:text-[hsl(220_14%_14%)]"
                    >
                      {column.label}
                      {sort?.key === column.key ? (
                        sort.dir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {topPad > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={list.columns.length}
                    style={{ height: topPad, padding: 0, border: 0 }}
                  />
                </tr>
              )}
              {visible.map((row, i) => {
                const index = start + i;
                const rowPath = resolveRowPath(list, row);
                return (
                  <tr
                    key={stableRowId(row, list, index)}
                    onClick={rowPath ? () => handleRowClick(row) : undefined}
                    className={
                      rowPath
                        ? 'cursor-pointer hover:bg-[hsl(220_14%_96%)]'
                        : undefined
                    }
                  >
                    {list.columns.map((column) => (
                      <td
                        key={column.key}
                        className="px-4 py-2 text-[hsl(220_14%_14%)]"
                      >
                        {renderCell(column, row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {bottomPad > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={list.columns.length}
                    style={{ height: bottomPad, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="border-t border-[hsl(220_14%_89%)] px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onLoadMore}
            style={{ minHeight: targetSize }}
          >
            加载更多
          </Button>
        </div>
      )}
    </section>
  );
}

interface WorkbenchListSectionProps {
  list: ListDefinition;
  role: RoleWorkbenchRole;
  personId?: string;
  state: ListState;
  targetSize: number;
  exportState: ExportState;
  filterInputRef: (element: HTMLInputElement | null) => void;
  onFilterFocus: () => void;
  onFilter: (value: string) => void;
  onToggleSort: (columnKey: string) => void;
  onLoadMore: () => void;
  onSaveView: () => void;
  onExport: () => void;
}

/**
 * 单个列表的独立数据节点：服务端分页/筛选/排序，跨页累积 rows。
 */
function WorkbenchListSection({
  list,
  role,
  personId,
  state,
  targetSize,
  exportState,
  filterInputRef,
  onFilterFocus,
  onFilter,
  onToggleSort,
  onLoadMore,
  onSaveView,
  onExport,
}: WorkbenchListSectionProps): React.ReactElement {
  const listQuery = useQuery({
    queryKey: [
      'workbench-list',
      role,
      list.key,
      state.filter,
      state.sort?.key,
      state.sort?.dir,
      state.page,
      PAGE_SIZE,
    ],
    queryFn: () =>
      getWorkbenchList(
        role,
        list.key,
        {
          page: state.page,
          pageSize: PAGE_SIZE,
          filter: state.filter,
          sortKey: state.sort?.key,
          sortDir: state.sort?.dir,
        },
        personId,
      ),
    staleTime: 30_000,
  });

  // 跨页累积：加载更多时把新一页追加到已加载行中。
  const [loaded, setLoaded] = useState<Array<Record<string, unknown>>>([]);
  const prevPageRef = useRef(1);
  useEffect(() => {
    if (!listQuery.data) return;
    const items = toSchemaRows(list, listQuery.data.items ?? []);
    const dataPage = listQuery.data.page ?? state.page;
    if (dataPage === 1) {
      setLoaded(items);
    } else if (dataPage === prevPageRef.current + 1) {
      setLoaded((current) => [...current, ...items]);
    }
    prevPageRef.current = dataPage;
  }, [listQuery.data, list, state.page]);

  const total = listQuery.data?.total ?? 0;
  const hasMore = listQuery.data?.hasMore ?? false;
  const listError = listQuery.isError;

  return (
    <WorkbenchList
      list={list}
      rows={loaded}
      total={total}
      loading={listQuery.isLoading}
      listError={listError}
      hasMore={hasMore}
      filter={state.filter}
      sort={state.sort}
      targetSize={targetSize}
      exportState={exportState}
      filterInputRef={filterInputRef}
      onFilterFocus={onFilterFocus}
      onFilter={onFilter}
      onToggleSort={onToggleSort}
      onLoadMore={onLoadMore}
      onSaveView={onSaveView}
      onExport={onExport}
      onRefresh={() => listQuery.refetch()}
      error={listQuery.error}
    />
  );
}

export default function RoleWorkbench(): React.ReactElement {
  const authRoles = useMemo(() => getAuthUser()?.roles ?? [], []);
  const personId = useMemo(() => getAuthUser()?.userId ?? undefined, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  });

  // TR-9.2: 默认角色来自当前认证用户，普通用户绝不默认 manager。
  // 角色以 URL 为准，刷新/前进后退/复制链接均可恢复。
  const role: RoleWorkbenchRole = useMemo(() => {
    const found = ROLES.find((item) => item.key === searchParams.get('role'));
    return found ? found.key : resolveDefaultWorkbenchRole(authRoles);
  }, [searchParams, authRoles]);

  const [debugMode, setDebugMode] = useState(false);
  // 多输入方式：默认由平台能力推断（触摸/键盘），管理员可切换单手/手套以放大触控目标。
  const [inputMode, setInputMode] = useState<WorkbenchInputMode>(() =>
    inferInputMode({
      hasTouch:
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
      coarsePointer:
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
    }),
  );
  const targetSize = touchTargetSize(inputMode);
  const filterInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const activeListKeyRef = useRef<string | null>(null);
  const navigate = useNavigate();

  const workbenchQuery = useQuery({
    queryKey: queryKeys.roleWorkbench(role),
    queryFn: () => getRoleWorkbench(role, role === 'operator' ? personId : undefined),
    staleTime: 30_000,
  });

  const schema = getRoleSchema(role);
  const data = workbenchQuery.data?.data ?? {};
  const generatedAt = workbenchQuery.data?.generatedAt;

  // 服务端判定：调试/模拟权限与可访问角色集（不信任前端 role 参数）。
  const serverAuthorized = workbenchQuery.data?.authorizedRoles;
  const canDebug =
    workbenchQuery.data?.canDebug ?? canUseWorkbenchDebug(authRoles);
  const simulating = Boolean(workbenchQuery.data?.simulating);

  // 客户端镜像在数据到达前先渲染标签；数据到达后以服务端为准。
  const clientAuthorized = useMemo(
    () => resolveAuthorizedWorkbenchRoles(authRoles),
    [authRoles],
  );
  const visibleRoles =
    serverAuthorized && serverAuthorized.length > 0
      ? serverAuthorized
      : clientAuthorized;
  const visibleTabs = useMemo(
    () => ROLES.filter((item) => visibleRoles.includes(item.key)),
    [visibleRoles],
  );

  // 每个列表的查询状态（从 URL 派生，刷新/复制链接可恢复）。
  const listStates = useMemo(
    () => readListStates(searchParams, schema.lists),
    [searchParams, schema],
  );

  // ---- 保存视图：服务端持久化 / 跨设备 / 共享 ----
  const [savedViews, setSavedViews] = useState<WorkbenchView[]>([]);
  const refreshViews = useCallback(() => {
    listWorkbenchViews()
      .then(setSavedViews)
      .catch(() => {
        // 视图加载失败保持静默，不影响主流程。
      });
  }, []);

  useEffect(() => {
    refreshViews();
  }, [refreshViews, role]);

  const savedViewsForRole = useMemo(
    () => savedViews.filter((view) => view.role === role),
    [savedViews, role],
  );

  const saveListView = useCallback(
    async (listKey: string) => {
      const st = listStates[listKey];
      try {
        await saveWorkbenchView(serverViewKey(role, listKey), {
          role,
          listKey,
          filter: st?.filter ?? '',
          sortKey: st?.sort?.key,
          sortDir: st?.sort?.dir,
          limit: PAGE_SIZE,
        });
        refreshViews();
      } catch {
        // 保存失败保持静默，不打断用户操作。
      }
    },
    [role, listStates, refreshViews],
  );

  const deleteView = useCallback(
    async (key: string) => {
      try {
        await deleteWorkbenchView(key);
      } catch {
        // 删除失败保持静默。
      }
      refreshViews();
    },
    [refreshViews],
  );

  // 一次性迁移：把旧版 localStorage 视图推送到服务端后移除本地键（幂等）。
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(LEGACY_VIEW_PREFIX)) {
        keys.push(storageKey);
      }
    }
    for (const storageKey of keys) {
      const parsed = parseLegacyViewKey(storageKey);
      const legacy = parseSavedView(localStorage.getItem(storageKey));
      if (!parsed || !legacy) continue;
      saveWorkbenchView(serverViewKey(parsed.role, parsed.listKey), {
        role: parsed.role,
        listKey: parsed.listKey,
        filter: legacy.filter,
        sortKey: legacy.sortKey,
        sortDir: legacy.sortDir,
        limit: legacy.limit,
      })
        .then(() => localStorage.removeItem(storageKey))
        .catch(() => {
          // 迁移失败保留本地键，下次进入重试。
        });
    }
  }, []);

  // 加载该角色已保存的视图到 URL（仅填充 URL 中未显式给出的列表参数）。
  useEffect(() => {
    let cancelled = false;
    listWorkbenchViews()
      .then((views) => {
        if (cancelled) return;
        const next = new URLSearchParams(searchParamsRef.current);
        let changed = false;
        for (const view of views) {
          if (view.role !== role) continue;
          if (!next.has(`${view.listKey}.filter`) && view.filter) {
            next.set(`${view.listKey}.filter`, view.filter);
            changed = true;
          }
          if (!next.has(`${view.listKey}.sort`) && view.sortKey) {
            next.set(`${view.listKey}.sort`, view.sortKey);
            changed = true;
          }
          if (!next.has(`${view.listKey}.dir`) && view.sortDir) {
            next.set(`${view.listKey}.dir`, view.sortDir);
            changed = true;
          }
        }
        if (changed) setSearchParams(next, { replace: true });
      })
      .catch(() => {
        // 静默。
      });
    return () => {
      cancelled = true;
    };
  }, [role, setSearchParams]);

  // 导出状态：每个列表一个，展示进度并在完成后触发下载。
  const [exportStates, setExportStates] = useState<Record<string, ExportState>>({});
  useEffect(() => {
    setExportStates({});
  }, [role]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const maybeDownload = useCallback((url?: string) => {
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    anchor.target = '_blank';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, []);

  const pollExport = useCallback(
    (taskId: string, listKey: string) => {
      const tick = async () => {
        if (!mountedRef.current) return;
        try {
          const task = await getWorkbenchExportTask(taskId);
          if (!mountedRef.current) return;
          setExportStates((current) => ({
            ...current,
            [listKey]: { status: task.status, progress: task.progress },
          }));
          if (task.status === 'queued' || task.status === 'running') {
            window.setTimeout(tick, 1500);
          } else if (task.status === 'succeeded') {
            maybeDownload(task.downloadUrl);
          }
        } catch {
          if (mountedRef.current) {
            setExportStates((current) => ({
              ...current,
              [listKey]: { status: 'failed', progress: 0 },
            }));
          }
        }
      };
      void tick();
    },
    [maybeDownload],
  );

  const runExport = useCallback(
    async (listKey: string) => {
      const filter = listStates[listKey]?.filter ?? '';
      setExportStates((current) => ({
        ...current,
        [listKey]: { status: 'queued', progress: 0 },
      }));
      try {
        const task = await createWorkbenchExport(role, listKey, filter);
        if (!mountedRef.current) return;
        setExportStates((current) => ({
          ...current,
          [listKey]: { status: task.status, progress: task.progress },
        }));
        if (task.status === 'queued' || task.status === 'running') {
          pollExport(task.id, listKey);
        } else if (task.status === 'succeeded') {
          maybeDownload(task.downloadUrl);
        }
      } catch {
        if (mountedRef.current) {
          setExportStates((current) => ({
            ...current,
            [listKey]: { status: 'failed', progress: 0 },
          }));
        }
      }
    },
    [role, listStates, pollExport, maybeDownload],
  );

  // ---- URL 同步的查询参数更新 ----
  const setListFilter = useCallback(
    (listKey: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(`${listKey}.filter`, value);
        else next.delete(`${listKey}.filter`);
        next.set(`${listKey}.page`, '1');
        return next;
      });
    },
    [setSearchParams],
  );

  const toggleSort = useCallback(
    (listKey: string, columnKey: string) => {
      setSearchParams((prev) => {
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
      });
    },
    [setSearchParams],
  );

  const setListPage = useCallback(
    (listKey: string, page: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(`${listKey}.page`, String(page));
        return next;
      });
    },
    [setSearchParams],
  );

  const selectRole = useCallback(
    (next: RoleWorkbenchRole) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set('role', next);
        return params;
      });
    },
    [setSearchParams],
  );

  // 多输入方式：扫码枪 + 键盘快捷键（Ctrl/Cmd+F 聚焦筛选、Ctrl/Cmd+R 刷新、Ctrl/Cmd+S 保存视图）。
  useEffect(() => {
    const scanner = createWorkbenchScanner({
      onScan: (value) => {
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        if (!key) return;
        setListFilter(key, mergeScannedValue(listStates[key]?.filter ?? '', value));
      },
      onError: () => {
        // 扫码失败/过短：保持静默，用户可手动输入。
      },
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      scanner.handleKeyDown(event);
      const action = matchShortcut(event);
      if (!action) return;
      if (action === 'focus-filter') {
        event.preventDefault();
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        filterInputRefs.current[key ?? '']?.focus();
      } else if (action === 'refresh') {
        event.preventDefault();
        void workbenchQuery.refetch();
      } else if (action === 'save-view') {
        event.preventDefault();
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        if (key) void saveListView(key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [schema, listStates, setListFilter, saveListView, workbenchQuery]);

  const kpiCards = useMemo(
    () => schema.kpis.filter((kpi) => data[kpi.key] !== undefined),
    [schema, data],
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">角色任务工作台</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            {schema.description}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canDebug && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDebugMode((value) => !value)}
            >
              {debugMode ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              {debugMode ? '关闭诊断' : '诊断'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => workbenchQuery.refetch()}
            disabled={workbenchQuery.isFetching}
          >
            <RefreshCw className="size-3" />
            刷新
          </Button>
        </div>
      </header>

      {/* 输入方式切换：键盘 / 触摸 / 扫码 / 单手 / 手套（放大触控目标） */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="输入方式"
      >
        <span className="text-xs text-[hsl(218_10%_42%)]">输入方式：</span>
        {(
          [
            ['keyboard', '键盘'],
            ['touch', '触摸'],
            ['scan', '扫码'],
            ['singlehand', '单手'],
            ['glove', '手套'],
          ] as Array<[WorkbenchInputMode, string]>
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setInputMode(mode)}
            aria-pressed={inputMode === mode}
            className={`rounded-md px-3 py-2 text-xs font-medium ${
              inputMode === mode
                ? 'bg-[hsl(221_83%_53%)] text-white'
                : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
            }`}
            style={{ minHeight: targetSize }}
          >
            {label}
          </button>
        ))}
      </div>

      {simulating && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800"
        >
          <Users className="size-4 shrink-0" />
          <span>
            您正在以「{ROLES.find((item) => item.key === role)?.label ?? role}」角色
            模拟查看（管理员）。此视图不代表您的真实权限，仅用于诊断与演示。
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-1">
        {visibleTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => selectRole(item.key)}
            aria-pressed={role === item.key}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
              role === item.key
                ? 'bg-[hsl(221_83%_53%)] text-white'
                : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
            }`}
          >
            <Users className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      {schema.quickActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[hsl(218_10%_42%)]">快捷跳转：</span>
          {schema.quickActions.map((action) => (
            <Button
              key={action.to}
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs"
            >
              <Link to={action.to}>{action.label}</Link>
            </Button>
          ))}
        </div>
      )}

      <QueryState
        isLoading={workbenchQuery.isLoading}
        isFetching={workbenchQuery.isFetching}
        isError={workbenchQuery.isError}
        isEmpty={kpiCards.length === 0 && schema.lists.length === 0}
        onRefresh={() => workbenchQuery.refetch()}
        error={workbenchQuery.error}
        errorMessage={
          workbenchQuery.error instanceof Error
            ? workbenchQuery.error.message
            : '加载失败'
        }
        backHref="/command-center"
        loadingMessage="正在加载工作台"
        emptyMessage="当前角色暂无聚合数据。"
        updatedAt={workbenchQuery.dataUpdatedAt}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kpiCards.map((kpi) => (
            <div
              key={kpi.key}
              className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[hsl(218_10%_42%)]">{kpi.label}</p>
                {kpi.unit && (
                  <span className="text-xs text-[hsl(218_10%_42%)]">{kpi.unit}</span>
                )}
              </div>
              <p className="mt-1 text-2xl font-semibold text-[hsl(220_14%_14%)]">
                {formatValue(kpi.format, data[kpi.key])}
              </p>
              <p className="mt-2 text-xs text-[hsl(218_10%_42%)]">
                来源：{kpi.source}
              </p>
              <p className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">
                更新：{kpi.refreshHint}
                {generatedAt
                  ? ` · ${new Date(generatedAt).toLocaleTimeString('zh-CN', {
                      hour12: false,
                    })}`
                  : ''}
              </p>
            </div>
          ))}
        </div>

        {schema.lists.map((list) => (
          <WorkbenchListSection
            key={list.key}
            list={list}
            role={role}
            personId={personId}
            state={listStates[list.key] ?? { filter: '', sort: undefined, page: 1 }}
            targetSize={targetSize}
            exportState={exportStates[list.key] ?? { status: 'idle', progress: 0 }}
            filterInputRef={(element) => {
              filterInputRefs.current[list.key] = element;
            }}
            onFilterFocus={() => {
              activeListKeyRef.current = list.key;
            }}
            onFilter={(value) => setListFilter(list.key, value)}
            onToggleSort={(columnKey) => toggleSort(list.key, columnKey)}
            onLoadMore={() =>
              setListPage(list.key, (listStates[list.key]?.page ?? 1) + 1)
            }
            onSaveView={() => {
              void saveListView(list.key);
            }}
            onExport={() => {
              void runExport(list.key);
            }}
          />
        ))}

        {savedViewsForRole.length > 0 && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3">
            <h2 className="mb-2 text-xs font-semibold text-[hsl(220_14%_14%)]">
              已保存视图（服务端，跨设备）
            </h2>
            <ul className="space-y-1">
              {savedViewsForRole.map((view) => (
                <li
                  key={view.key}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm text-[hsl(218_10%_42%)]"
                >
                  <span>
                    {view.listKey}
                    {view.filter ? ` · ${view.filter}` : ''}
                    {view.sortKey ? ` · 按 ${view.sortKey}` : ''}
                    {view.shared ? ' · 共享' : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => {
                      void deleteView(view.key);
                    }}
                  >
                    <Trash2 className="size-3" />
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {debugMode && canDebug && (
          <section className="rounded-lg border border-dashed border-[hsl(220_14%_89%)] bg-slate-50 p-4">
            <h2 className="mb-2 text-sm font-semibold text-[hsl(220_14%_14%)]">
              原始诊断数据（服务端鉴权，仅管理员可见）
            </h2>
            <pre className="overflow-x-auto text-xs text-[hsl(218_10%_42%)]">
              {JSON.stringify(data, null, 2)}
            </pre>
          </section>
        )}
      </QueryState>
    </div>
  );
}