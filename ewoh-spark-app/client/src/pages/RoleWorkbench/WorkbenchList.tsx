import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ClipboardList,
  Download,
  Save,
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

export function WorkbenchList({
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

  const exporting = exportIsBusy(exportState);

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
  state: {
    filter: string;
    sort?: SortState;
    page: number;
  };
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
export function WorkbenchListSection({
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