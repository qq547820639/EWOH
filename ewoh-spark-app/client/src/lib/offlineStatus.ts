import type { SimpleStore, StoredPendingAction, SyncState } from './offlineDb';
import { getLastSyncAt } from './offlineDb';

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