import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Box,
  ClipboardList,
  CloudOff,
  Database,
  Download,
  Lock,
  RefreshCw,
  Save,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { getWorkbenchList, type RoleWorkbenchRole } from '../../api/operations';
import { Button } from '@client/src/components/ui/button';
import ErrorState from '../../components/ErrorState';
import {
  formatValue,
  type ColumnDefinition,
  type ListDefinition,
} from './roleSchema';
import { resolveRowPath, stableRowId } from './workbenchListLogic';
import { PAGE_SIZE, ROW_HEIGHT, type SortState } from './roleWorkbenchState';
import { useWindowedRange } from './useWindowedRange';
import {
  exportIsBusy,
  exportStatusLabel,
  type ExportState,
} from './workbenchExport';
import {
  isBlockingListState,
  resolveWorkbenchListState,
  workbenchListStateDescription,
  workbenchListStateTitle,
  type MetricAvailability,
  type WorkbenchListState,
} from './workbenchDataStates';

/**
 * 角色工作台的列表/表格组件：服务端分页查询、行虚拟化、筛选/排序、保存视图、
 * 导出、加载更多。由 RoleWorkbenchOrchestrator 组装每个列表的数据节点。
 */

/** 服务端对 object 形状的列表（如设备状态分布）会归一化为 `{ key, value }` 行。 */
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

interface WorkbenchListText {
  filter: string;
  sort?: SortState;
  page: number;
}

/** 数据页状态 → 图标与配色（由 availability 状态派生，非硬编码文案）。 */
const STATE_BLOCK_ICON: Partial<Record<WorkbenchListState, LucideIcon>> = {
  no_data: Box,
  not_configured: Database,
  permission_denied: Lock,
  source_unavailable: CloudOff,
  stale: TriangleAlert,
};

const STATE_BLOCK_CLASS: Partial<Record<WorkbenchListState, string>> = {
  no_data: 'border-[hsl(220_14%_89%)] bg-white',
  not_configured: 'border-amber-200 bg-amber-50',
  permission_denied: 'border-amber-200 bg-amber-50',
  source_unavailable: 'border-orange-200 bg-orange-50',
  stale: 'border-amber-200 bg-amber-50',
};

/**
 * 列表数据不可用时的确定性状态块（而非无限骨架屏）。由 dataState 驱动，
 * 展示中文标题/说明 + 重试，把「无业务数据」「无权限」「数据源错误」等区分开。
 * 绝不把 availability 对象当作普通行渲染。
 */
function ListStateBlock({
  list,
  state,
  availability,
  onRetry,
}: {
  list: ListDefinition;
  state: WorkbenchListState;
  availability?: MetricAvailability;
  onRetry: () => void;
}): React.ReactElement {
  const Icon = STATE_BLOCK_ICON[state] ?? Box;
  const source = availability ? availability.source : '';
  return (
    <div
      role={state === 'source_unavailable' ? 'alert' : 'status'}
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-lg border p-4 text-sm ${STATE_BLOCK_CLASS[state] ?? 'bg-white'}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-5 shrink-0 text-[hsl(218_10%_42%)]" />
        <div className="min-w-0">
          <p className="font-semibold text-[hsl(220_14%_14%)]">
            「{list.label}」{workbenchListStateTitle(state)}
          </p>
          <p className="mt-0.5 text-[hsl(218_10%_42%)]">
            {workbenchListStateDescription(state)}
          </p>
          {source && (
            <p className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">
              数据源：{source}
            </p>
          )}
        </div>
      </div>
      <div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          重试
        </Button>
      </div>
    </div>
  );
}

interface WorkbenchListProps {
  list: ListDefinition;
  rows: Array<Record<string, unknown>>;
  total: number;
  dataState: WorkbenchListState;
  availability?: MetricAvailability;
  dataFreshness?: string | null;
  hasMore: boolean;
  filter: string;
  sort?: SortState;
  targetSize: number;
  exportState: ExportState;
  filterInputRef: (element: HTMLInputElement | null) => void;
  onFilterFocus: () => void;
  onFilter: (value: string) => void;
  onClearFilter: (listKey: string) => void;
  onToggleSort: (columnKey: string) => void;
  onLoadMore: () => void;
  onSaveView: () => void;
  onExport: () => void;
  onRefresh: () => void;
  error: unknown;
}

export function WorkbenchList({
  list,
  rows,
  total,
  dataState,
  availability,
  dataFreshness,
  hasMore,
  filter,
  sort,
  targetSize,
  exportState,
  filterInputRef,
  onFilterFocus,
  onFilter,
  onClearFilter,
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

  const exporting = exportIsBusy(exportState);
  const hasActiveFilter = filter.length > 0;
  const blocking = isBlockingListState(dataState);

  return (
    <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-4 py-3">
        <ClipboardList className="size-4 text-[hsl(221_83%_53%)]" />
        <h2 className="font-semibold text-[hsl(220_14%_14%)]">{list.label}</h2>
        <span
          className="text-xs text-[hsl(218_10%_42%)]"
          title={
            dataFreshness
              ? `数据更新于 ${new Date(dataFreshness).toLocaleTimeString('zh-CN', {
                  hour12: false,
                })}`
              : undefined
          }
        >
          {dataState === 'loading'
            ? '加载中'
            : dataState === 'error'
              ? '加载失败'
              : blocking
                ? workbenchListStateTitle(dataState)
                : `${total} 条`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
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
            {hasActiveFilter && (
              <button
                type="button"
                aria-label={`清除${list.label}筛选`}
                onClick={() => onClearFilter(list.key)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[hsl(218_10%_42%)] hover:text-[hsl(220_14%_14%)]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
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
          {exporting ? (
            <span role="status" className="text-xs text-[hsl(218_10%_42%)]">
              {exportStatusLabel(exportState.status)} {exportState.progress}%
            </span>
          ) : exportState.status === 'succeeded' ? (
            <span role="status" className="text-xs font-medium text-green-700">
              {exportStatusLabel(exportState.status)}
            </span>
          ) : exportState.status === 'failed' ? (
            <span role="status" className="text-xs font-medium text-red-600">
              {exportStatusLabel(exportState.status)}
            </span>
          ) : null}
        </div>
      </div>

      {dataState === 'error' ? (
        <div className="p-4">
          <ErrorState
            error={error}
            errorMessage={`「${list.label}」数据加载失败，请稍后重试。`}
            onRetry={onRefresh}
            backLabel="返回工作台"
          />
        </div>
      ) : blocking ? (
        <div className="p-4">
          <ListStateBlock
            list={list}
            state={dataState}
            availability={availability}
            onRetry={onRefresh}
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
  state: {
    filter: string;
    sort?: SortState;
    page: number;
  };
  targetSize: number;
  exportState: ExportState;
  availability?: MetricAvailability;
  filterInputRef: (element: HTMLInputElement | null) => void;
  onFilterFocus: () => void;
  onFilter: (value: string) => void;
  onClearFilter: (listKey: string) => void;
  onToggleSort: (columnKey: string) => void;
  onLoadMore: () => void;
  onSaveView: () => void;
  onExport: () => void;
}

/**
 * 单个列表的独立数据节点：服务端分页/筛选/排序，跨页累积 rows。
 * 若该列表在后端 workbench data 中标为 availability（无业务数据/无权限/数据源错误等），
 * 则跳过列表查询并直接渲染确定性状态块，绝不把 availability 当作普通行。
 */
export function WorkbenchListSection({
  list,
  role,
  personId,
  state,
  targetSize,
  exportState,
  availability,
  filterInputRef,
  onFilterFocus,
  onFilter,
  onClearFilter,
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
    enabled: !availability,
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
  const dataState = resolveWorkbenchListState({
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    isFetching: listQuery.isFetching,
    hasData: Boolean(listQuery.data),
    total,
    apiStatus: listQuery.data?.status,
    availability,
  });

  return (
    <WorkbenchList
      list={list}
      rows={loaded}
      total={total}
      dataState={dataState}
      availability={availability}
      dataFreshness={listQuery.data?.dataFreshness ?? null}
      hasMore={hasMore}
      filter={state.filter}
      sort={state.sort}
      targetSize={targetSize}
      exportState={exportState}
      filterInputRef={filterInputRef}
      onFilterFocus={onFilterFocus}
      onFilter={onFilter}
      onClearFilter={onClearFilter}
      onToggleSort={onToggleSort}
      onLoadMore={onLoadMore}
      onSaveView={onSaveView}
      onExport={onExport}
      onRefresh={() => listQuery.refetch()}
      error={listQuery.error}
    />
  );
}