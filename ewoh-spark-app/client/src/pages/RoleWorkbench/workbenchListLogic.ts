import {
  formatValue,
  type ListDefinition,
} from './roleSchema';

/**
 * Pure list behavior helpers for the Role Workbench (node-testable, no DOM).
 * Covers TR-9.3 behavior requirements: detecting a per-list error, stable
 * business-ID React keys, row-click navigation to a specific entity path,
 * CSV export buffer building, and saved-view (de)serialization.
 */

export interface SavedView {
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

/** Candidate keys for a stable business identifier on a workbench row. */
const STABLE_ID_KEYS = [
  'id',
  'stepId',
  'entityId',
  'scheduleTaskId',
  'taskId',
  'assetId',
  'defectCode',
  'workCenterId',
  'riskType',
  'status',
];

/**
 * Returns a stable React key for a row. Prefers a business ID field when
 * present; otherwise falls back to the first defined column value, then to the
 * row index. Using business IDs (not the array index) keeps rows stable across
 * re-sorts / filters (TR-9.3 / spec item 5).
 */
export function stableRowId(
  row: Record<string, unknown>,
  list: ListDefinition,
  index: number,
): string {
  for (const key of STABLE_ID_KEYS) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return `${key}:${String(value)}`;
    }
  }
  for (const column of list.columns) {
    const value = row[column.key];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return `${column.key}:${String(value)}`;
    }
  }
  return `row:${index}`;
}

/**
 * Whether a list's raw payload should be treated as an error (missing or the
 * wrong shape). A list that has a transform accepts any raw value; otherwise
 * only an array is valid.
 */
export function detectListError(
  raw: unknown,
  hasTransform: boolean,
): boolean {
  if (raw === undefined || raw === null) {
    return true;
  }
  if (hasTransform) {
    return false;
  }
  return !Array.isArray(raw);
}

/**
 * Resolves the navigation path for a row. Prefers the first link column: the
 * entity id is taken from `link.valueKey` when present, otherwise from the
 * column's own key (the schema names link columns after the id field, e.g.
 * `entityId`). This deep-links different rows to different entities instead of
 * one static route (TR-9.3 / spec item 6). Falls back to the list's static
 * `rowTo`.
 */
export function resolveRowPath(
  list: ListDefinition,
  row: Record<string, unknown>,
): string | null {
  const linkColumn = list.columns.find((column) => column.link);
  if (linkColumn?.link) {
    const valueKey = linkColumn.link.valueKey ?? linkColumn.key;
    const value = row[valueKey];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return `${linkColumn.link.to}/${encodeURIComponent(String(value))}`;
    }
  }
  return list.rowTo ?? null;
}

/**
 * Builds a UTF-8 BOM CSV string from a list definition and rows. Pure function
 * (no Blob / DOM) so it can be unit-tested in a node environment.
 */
export function buildCsv(
  list: ListDefinition,
  rows: Array<Record<string, unknown>>,
): string {
  const header = list.columns.map((column) => column.label).join(',');
  const body = rows
    .map((row) =>
      list.columns
        .map((column) => {
          const text = formatValue(column.format, row[column.key]);
          return `"${String(text).replace(/"/g, '""')}"`;
        })
        .join(','),
    )
    .join('\n');
  return `\uFEFF${header}\n${body}`;
}

export function serializeSavedView(view: SavedView): string {
  return JSON.stringify(view);
}

export function parseSavedView(raw: string | null): SavedView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedView;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}