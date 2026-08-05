/**
 * Server-side list query handling for the Role Workbench.
 *
 * The workbench used to return every row (`.limit(5000)`) and let the client
 * paginate / filter / sort and build the CSV in a browser Blob. Instead the
 * server owns pagination, filtering, sorting and (via the async export task)
 * large-data export. This module is the pure, DB-free part of that logic so it
 * can be unit-tested without a real PostgreSQL connection:
 *   - `parseWorkbenchListQuery` normalises + clamps page / pageSize / filter /
 *     sortKey / sortDir into a bounded query (offset computed server-side);
 *   - `queryWorkbenchList` applies filter → sort → pagination over a row set
 *     and returns the page shape the client renders.
 *
 * The actual drizzle SELECT (COUNT + LIMIT/OFFSET over the source tables) lives
 * in the service and requires a live database — that path is
 * `BLOCKED_BY_ENVIRONMENT` in CI (see README / test harness notes).
 */

export interface WorkbenchListColumn {
  key: string;
  label: string;
}

export interface WorkbenchListQueryInput {
  page?: number;
  pageSize?: number;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
}

export interface WorkbenchListQuery {
  page: number;
  pageSize: number;
  filter: string;
  sortKey: string | null;
  sortDir: 'asc' | 'desc';
  /** Zero-based offset for the current page (server-side window). */
  offset: number;
}

export interface WorkbenchListResult<T = Record<string, unknown>> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_FILTER_LENGTH = 120;

/** Normalises and clamps a raw list query into a bounded, server-authoritative query. */
export function parseWorkbenchListQuery(
  raw: WorkbenchListQueryInput | Record<string, unknown>,
): WorkbenchListQuery {
  const input = (raw ?? {}) as Record<string, unknown>;
  const rawPage = Number(input.page ?? 1);
  const rawPageSize = Number(input.pageSize ?? DEFAULT_PAGE_SIZE);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(rawPageSize)))
    : DEFAULT_PAGE_SIZE;

  const filter = typeof input.filter === 'string' ? input.filter.slice(0, MAX_FILTER_LENGTH) : '';
  const sortKey = typeof input.sortKey === 'string' && input.sortKey.length > 0 ? input.sortKey : null;
  const sortDir = input.sortDir === 'asc' ? 'asc' : input.sortDir === 'desc' ? 'desc' : 'asc';

  return {
    page,
    pageSize,
    filter,
    sortKey,
    sortDir,
    offset: (page - 1) * pageSize,
  };
}

/** Returns true when a row matches the textual filter across the given columns. */
export function matchesFilter(row, columns: WorkbenchListColumn[], filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return columns.some((column) => String(row[column.key] ?? '').toLowerCase().includes(q));
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN');
}

/**
 * Server-side filter → sort → paginate over a row set. Returns the bounded page
 * (offset = (page-1)*pageSize) plus the total row count after filtering.
 */
export function queryWorkbenchList<T extends Record<string, unknown>>(
  rows: T[],
  columns: WorkbenchListColumn[],
  query: WorkbenchListQuery,
): WorkbenchListResult<T> {
  let working = rows.filter((row) => matchesFilter(row, columns, query.filter));

  if (query.sortKey) {
    const key = query.sortKey;
    const dir = query.sortDir;
    working = [...working].sort((a, b) => {
      const cmp = compareValues(a[key], b[key]);
      return dir === 'asc' ? cmp : -cmp;
    });
  }

  const total = working.length;
  const items = working.slice(query.offset, query.offset + query.pageSize);
  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.offset + query.pageSize < total,
  };
}