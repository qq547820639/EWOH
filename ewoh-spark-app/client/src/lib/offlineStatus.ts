import type { SimpleStore, StoredPendingAction, SyncState } from './offlineDb';
import { backoffDelayWithJitter, getLastSyncAt } from './offlineDb';

/** Threshold after which a workbench is considered "data stale" (no sync). */
export const STALE_DATA_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Computes the next scheduled retry time for a failed item, based on its retry
 * count and last attempt time (exponential backoff + jitter). Returns null for
 * non-failed items or when there is nothing to schedule. Pure and injectable.
 */
export function computeNextRetryAt(
  item: StoredPendingAction,
  now: number = Date.now(),
): string | null {
  if (item.status !== 'failed') {
    return null;
  }
  const attempts = item.retryCount ?? 0;
  const base = item.lastAttemptAt ? new Date(item.lastAttemptAt).getTime() : now;
  if (Number.isNaN(base)) {
    return null;
  }
  return new Date(base + backoffDelayWithJitter(attempts)).toISOString();
}

/**
 * Whether the last successful sync is older than `thresholdMs`, i.e. the
 * workbench data is stale and the user should be warned. Pure and injectable.
 */
export function isDataStale(
  lastSyncAt: string | null,
  now: number = Date.now(),
  thresholdMs: number = STALE_DATA_THRESHOLD_MS,
): boolean {
  if (!lastSyncAt) {
    return false;
  }
  const then = new Date(lastSyncAt).getTime();
  if (Number.isNaN(then)) {
    return false;
  }
  return now - then > thresholdMs;
}

export interface OfflineStatusSnapshot {
  online: boolean;
  pendingCount: number;
  lastSyncAt: string | null;
  syncing: boolean;
}

export function isNavigatorOnline(): boolean {
  if (typeof navigator === 'undefined') {
    return true;
  }
  return navigator.onLine;
}

/** Formats a last-sync timestamp for display ("刚刚 / HH:mm:ss"). */
export function formatLastSync(lastSyncAt: string | null): string {
  if (!lastSyncAt) {
    return '从未同步';
  }
  const then = new Date(lastSyncAt).getTime();
  if (Number.isNaN(then)) {
    return '从未同步';
  }
  const elapsedMs = Date.now() - then;
  if (elapsedMs < 60_000) {
    return '刚刚';
  }
  return new Date(lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * Builds an offline status snapshot from the persisted store. Pure and
 * injectable so tests can drive it with a fake store.
 */
export async function readOfflineStatus(
  pendingStore: SimpleStore<StoredPendingAction>,
  syncStateStore: SimpleStore<SyncState>,
  online: boolean = isNavigatorOnline(),
): Promise<OfflineStatusSnapshot> {
  const [pendingCount, lastSyncAt] = await Promise.all([
    pendingStore.count(),
    getLastSyncAt(syncStateStore),
  ]);
  return {
    online,
    pendingCount,
    lastSyncAt,
    syncing: false,
  };
}

/** Counts queued items that still need syncing (not synced). */
export function countPending(items: StoredPendingAction[]): number {
  return items.filter((item) => item.status !== 'synced').length;
}