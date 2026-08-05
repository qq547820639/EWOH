import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
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
  Users,
} from 'lucide-react';
import {
  getRoleWorkbench,
  type RoleWorkbenchRole,
} from '../../api/operations';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import QueryState from '../../components/QueryState';
import ErrorState from '../../components/ErrorState';
import {
  hasMoreItems,
  nextProgressiveLimit,
  progressiveSlice,
} from '../../lib/progressiveList';
import {
  formatValue,
  getRoleSchema,
  type ColumnDefinition,
  type ListDefinition,
} from './roleSchema';
import { prioritySortRows } from './priorityTriage';
import {
  canUseWorkbenchDebug,
  resolveAuthorizedWorkbenchRoles,
  resolveDefaultWorkbenchRole,
} from './workbenchAccess';
import {
  buildCsv,
  detectListError,
  parseSavedView,
  resolveRowPath,
  serializeSavedView,
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

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

function viewKey(role: RoleWorkbenchRole, listKey: string): string {
  return `ewoh.roleWorkbench.view.${role}.${listKey}`;
}

function loadView(role: RoleWorkbenchRole, listKey: string): SavedView | null {
  try {
    const raw = localStorage.getItem(viewKey(role, listKey));
    return parseSavedView(raw);
  } catch {
    return null;
  }
}

function sortRows(
  rows: Array<Record<string, unknown>>,
  column: ColumnDefinition,
  dir: 'asc' | 'desc',
): Array<Record<string, unknown>> {
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[column.key];
    const bv = b[column.key];
    let cmp = 0;
    if (av === bv) cmp = 0;
    else if (av === null || av === undefined) cmp = 1;
    else if (bv === null || bv === undefined) cmp = -1;
    else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv), 'zh-CN');
    return dir === 'asc' ? cmp : -cmp;
  });
  return copy;
}

function filterRows(
  rows: Array<Record<string, unknown>>,
  columns: ColumnDefinition[],
  filter: string,
): Array<Record<string, unknown>> {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    columns.some((column) =>
      String(row[column.key] ?? '').toLowerCase().includes(q),
    ),
  );
}

function exportCsv(list: ListDefinition, rows: Array<Record<string, unknown>>): void {
  const content = buildCsv(list, rows);
  const blob = new Blob([content], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${list.label}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
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
  listError: boolean;
  filter: string;
  sort?: SortState;
  limit: number;
  targetSize: number;
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
  listError,
  filter,
  sort,
  limit,
  targetSize,
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

  const filtered = useMemo(
    () => filterRows(rows, list.columns, filter),
    [rows, list.columns, filter],
  );
  const sorted = useMemo(
    () =>
      sort
        ? sortRows(
            filtered,
            list.columns.find((column) => column.key === sort.key) ??
              list.columns[0],
            sort.dir,
          )
        : // 未显式选择排序时，默认「待处理事项优先」：存在优先级列则按优先级升序前置高优项。
          prioritySortRows(filtered, list.columns),
    [filtered, sort, list.columns],
  );
  const visible = progressiveSlice(sorted, limit);
  const hasMore = hasMoreItems(sorted, limit);

  const handleRowClick = (row: Record<string, unknown>) => {
    const path = resolveRowPath(list, row);
    if (path) navigate(path);
  };

  return (
    <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-4 py-3">
        <ClipboardList className="size-4 text-[hsl(221_83%_53%)]" />
        <h2 className="font-semibold text-[hsl(220_14%_14%)]">{list.label}</h2>
        <span className="text-xs text-[hsl(218_10%_42%)]">
          {listError ? '加载失败' : `${sorted.length} 条`}
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
          >
            <Download className="size-3" />
            导出
          </Button>
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
      ) : visible.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[hsl(218_10%_42%)]">{list.emptyText}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                {list.columns.map((column) => (
                  <th key={column.key} className="px-4 py-2 font-medium">
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
              {visible.map((row, index) => {
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
                      <td key={column.key} className="px-4 py-2 text-[hsl(220_14%_14%)]">
                        {renderCell(column, row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
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

export default function RoleWorkbench(): React.ReactElement {
  const authRoles = useMemo(() => getAuthUser()?.roles ?? [], []);
  const personId = useMemo(() => getAuthUser()?.userId ?? undefined, []);

  // TR-9.2: 默认角色来自当前认证用户，普通用户绝不默认 manager。
  const [role, setRole] = useState<RoleWorkbenchRole>(() =>
    resolveDefaultWorkbenchRole(authRoles),
  );
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [sortState, setSortState] = useState<Record<string, SortState>>({});
  const [filterState, setFilterState] = useState<Record<string, string>>({});
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

  // 加载该角色已保存的视图（筛选/排序/加载更多）。
  useEffect(() => {
    const filter: Record<string, string> = {};
    const sort: Record<string, SortState> = {};
    const lim: Record<string, number> = {};
    for (const list of schema.lists) {
      const saved = loadView(role, list.key);
      if (saved) {
        if (saved.filter) filter[list.key] = saved.filter;
        if (saved.sortKey) {
          sort[list.key] = { key: saved.sortKey, dir: saved.sortDir ?? 'asc' };
        }
        if (saved.limit) lim[list.key] = saved.limit;
      }
    }
    setFilterState(filter);
    setSortState(sort);
    setLimits(lim);
  }, [role, schema]);

  const saveView = useCallback(() => {
    for (const list of schema.lists) {
      localStorage.setItem(
        viewKey(role, list.key),
        serializeSavedView({
          filter: filterState[list.key] ?? '',
          sortKey: sortState[list.key]?.key,
          sortDir: sortState[list.key]?.dir,
          limit: limits[list.key] ?? 50,
        }),
      );
    }
  }, [schema, role, filterState, sortState, limits]);

  // 多输入方式：扫码枪 + 键盘快捷键（Ctrl/Cmd+F 聚焦筛选、Ctrl/Cmd+R 刷新、Ctrl/Cmd+S 保存视图）。
  useEffect(() => {
    const scanner = createWorkbenchScanner({
      onScan: (value) => {
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        if (!key) return;
        setFilterState((current) => ({
          ...current,
          [key]: mergeScannedValue(current[key] ?? '', value),
        }));
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
        saveView();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [schema, saveView]);

  const toggleSort = useCallback(
    (listKey: string, columnKey: string) => {
      setSortState((current) => {
        const existing = current[listKey];
        const next: SortState =
          existing && existing.key === columnKey
            ? { key: columnKey, dir: existing.dir === 'asc' ? 'desc' : 'asc' }
            : { key: columnKey, dir: 'asc' };
        return { ...current, [listKey]: next };
      });
    },
    [],
  );

  const setFilter = useCallback((listKey: string, value: string) => {
    setFilterState((current) => ({ ...current, [listKey]: value }));
  }, []);

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
            onClick={() => setRole(item.key)}
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

        {schema.lists.map((list) => {
          const raw = data[list.key];
          let rows: Array<Record<string, unknown>> = [];
          const listError = detectListError(raw, Boolean(list.transform));
          if (!listError) {
            if (list.transform) {
              rows = list.transform(raw);
            } else {
              rows = raw as Array<Record<string, unknown>>;
            }
          }

          return (
            <WorkbenchList
              key={list.key}
              list={list}
              rows={rows}
              listError={listError}
              error={workbenchQuery.error}
              filter={filterState[list.key] ?? ''}
              sort={sortState[list.key]}
              limit={limits[list.key] ?? 50}
              targetSize={targetSize}
              filterInputRef={(element) => {
                filterInputRefs.current[list.key] = element;
              }}
              onFilterFocus={() => {
                activeListKeyRef.current = list.key;
              }}
              onFilter={(value) => setFilter(list.key, value)}
              onToggleSort={(columnKey) => toggleSort(list.key, columnKey)}
              onLoadMore={() =>
                setLimits((current) => ({
                  ...current,
                  [list.key]: nextProgressiveLimit(current[list.key] ?? 50),
                }))
              }
              onSaveView={() => saveView()}
              onExport={() => exportCsv(list, rows)}
              onRefresh={() => workbenchQuery.refetch()}
            />
          );
        })}

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