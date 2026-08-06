/**
 * Server-side list query handling for the Role Workbench.
 *
 * Two execution paths are supported:
 *   - **DB-backed (primary)**: `RoleWorkbenchService.getWorkbenchList` performs
 *     REAL PostgreSQL queries (parameterised WHERE + ORDER BY + LIMIT/OFFSET and
 *     keyset cursor pagination) for the tabular row-based lists. The pure
 *     helpers in this module supply the cursor encode/decode + stable-sort
 *     protocol used by that path.
 *   - **Pure in-memory (fallback)**: `parseWorkbenchListQuery` / `queryWorkbenchList`
 *     remain for trivial object-shaped lists (e.g. device-status distributions,
 *     defect Pareto) that are best produced by the dashboard aggregation rather
 *     than a table scan.
 *
 * Cursor protocol (stable, duplicate-safe):
 *   A page is identified by `{ sortValue, id }` where `id` is a unique column.
 *   The server ORDER BY is `(sortColumn, uniqueColumn)` so that rows sharing the
 *   same sort value are still returned once and only once across pages
 *   (no duplicate / no omission). The opaque cursor is a base64url-encoded JSON
 *   object. Offset mode (`page`/`pageSize`) remains an accurate alternative.
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
  /** Opaque base64url cursor for keyset pagination (takes precedence over page/offset). */
  cursor?: string;
}

export interface WorkbenchListQuery {
  page: number;
  pageSize: number;
  filter: string;
  sortKey: string | null;
  sortDir: 'asc' | 'desc';
  /** Zero-based offset for the current page (server-side window). */
  offset: number;
  /** Decoded cursor, or null when offset mode is used. */
  cursor: string | null;
}

export type WorkbenchListStatus = 'ok' | 'no_data' | 'source_unavailable';

export interface WorkbenchListResult<T = Record<string, unknown>> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Cursor-mode flag: true when a next page exists. Mirrors `hasMore` in offset mode. */
  hasNextPage: boolean;
  /** Opaque cursor for the next page (null in offset mode or when at the end). */
  nextCursor: string | null;
  /** Per-list data availability. */
  status: WorkbenchListStatus;
  /** ISO timestamp of when the page was produced. */
  dataFreshness: string;
}

/** Stable keyset cursor: the sort value plus a unique tiebreaker id. */
export interface WorkbenchCursor {
  sortValue: string;
  id: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_FILTER_LENGTH = 120;

/**
 * Encodes a stable keyset cursor into an opaque base64url string. The sort value
 * is stored in its SQL-comparable string form (ISO for timestamps) so decoding
 * can be replayed against the originating sort column.
 */
export function encodeWorkbenchCursor(cursor: WorkbenchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor back into `{ sortValue, id }`. Returns null for
 * malformed / tampered input so the caller can fall back to the first page
 * rather than throw.
 */
export function decodeWorkbenchCursor(cursor: string): WorkbenchCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<WorkbenchCursor>;
    if (
      parsed &&
      typeof parsed.sortValue === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return { sortValue: parsed.sortValue, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

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

  const filter =
    typeof input.filter === 'string'
      ? input.filter.slice(0, MAX_FILTER_LENGTH)
      : '';
  const sortKey =
    typeof input.sortKey === 'string' && input.sortKey.length > 0
      ? input.sortKey
      : null;
  const sortDir =
    input.sortDir === 'asc' ? 'asc' : input.sortDir === 'desc' ? 'desc' : 'asc';
  const cursor =
    typeof input.cursor === 'string' && input.cursor.length > 0
      ? input.cursor
      : null;

  return {
    page,
    pageSize,
    filter,
    sortKey,
    sortDir,
    offset: (page - 1) * pageSize,
    cursor,
  };
}

/** Returns true when a row matches the textual filter across the given columns. */
export function matchesFilter(
  row,
  columns: WorkbenchListColumn[],
  filter: string,
): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return columns.some((column) =>
    String(row[column.key] ?? '').toLowerCase().includes(q),
  );
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN');
}

/**
 * Server-side filter → sort → paginate over an in-memory row set. Used for
 * trivial object-shaped lists. Returns the bounded page plus metadata.
 */
export function queryWorkbenchList<T extends Record<string, unknown>>(
  rows: T[],
  columns: WorkbenchListColumn[],
  query: WorkbenchListQuery,
): WorkbenchListResult<T> {
  let working = rows.filter((row) =>
    matchesFilter(row, columns, query.filter),
  );

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
  const hasMore = query.offset + query.pageSize < total;
  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore,
    hasNextPage: hasMore,
    nextCursor: null,
    status: 'ok',
    dataFreshness: new Date().toISOString(),
  };
}