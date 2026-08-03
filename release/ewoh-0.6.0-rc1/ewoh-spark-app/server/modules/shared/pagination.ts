export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface CursorQuery {
  cursor?: string;
  limit?: number;
}

export interface PageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CursorResponse<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface PageLimits {
  defaultPageSize?: number;
  maxPageSize?: number;
}

export interface CursorLimits {
  defaultLimit?: number;
  maxLimit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function parsePageQuery(
  query: PageQuery | Record<string, unknown>,
  limits: PageLimits = {},
): Required<PageQuery> {
  const maxPageSize = limits.maxPageSize ?? MAX_PAGE_SIZE;
  const defaultPageSize = Math.min(limits.defaultPageSize ?? DEFAULT_PAGE_SIZE, maxPageSize);
  const raw = query as Record<string, unknown>;

  const rawPage = Number(raw.page ?? 1);
  const rawPageSize = Number(raw.pageSize ?? defaultPageSize);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(maxPageSize, Math.max(1, Math.floor(rawPageSize)))
    : defaultPageSize;

  return { page, pageSize };
}

export function parseCursorQuery(
  query: CursorQuery | Record<string, unknown>,
  limits: CursorLimits = {},
): { cursor?: string; limit: number } {
  const maxLimit = limits.maxLimit ?? MAX_LIMIT;
  const defaultLimit = Math.min(limits.defaultLimit ?? DEFAULT_LIMIT, maxLimit);
  const raw = query as Record<string, unknown>;

  const rawCursor = raw.cursor;
  const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : undefined;
  const rawLimit = Number(raw.limit ?? defaultLimit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(maxLimit, Math.max(1, Math.floor(rawLimit)))
    : defaultLimit;

  return { cursor, limit };
}

export function toPageResponse<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PageResponse<T> {
  const parsed = parsePageQuery({ page, pageSize });
  return {
    items,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
    hasMore: parsed.page * parsed.pageSize < total,
  };
}

export function toCursorResponse<T>(
  items: T[],
  nextCursor?: string,
  hasMore = Boolean(nextCursor),
): CursorResponse<T> {
  return {
    items,
    nextCursor: hasMore ? nextCursor : undefined,
    hasMore,
  };
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T = unknown>(cursor: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}
