import {
  computeNextRetryAt,
  countPending,
  formatLastSync,
  isDataStale,
  readOfflineStatus,
} from './offlineStatus';
import type { SimpleStore, StoredPendingAction, SyncState } from './offlineDb';

function createMemoryStore<T extends { key: string }>(): SimpleStore<T> & {
  values: Map<string, T>;
} {
  const values = new Map<string, T>();
  return {
    values,
    async getAll() {
      return Array.from(values.values());
    },
    async get(key) {
      return values.get(key);
    },
    async put(value) {
      values.set(value.key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
    async count() {
      return values.size;
    },
  };
}

describe('offlineStatus', () => {
  it('counts only unsynced pending items', () => {
    const items: StoredPendingAction[] = [
      { key: 'a', id: 'a', type: 'transition', orderId: 'WO', stepId: 'S', idempotencyKey: 'k', queuedAt: '', status: 'local' },
      { key: 'b', id: 'b', type: 'transition', orderId: 'WO', stepId: 'S', idempotencyKey: 'k', queuedAt: '', status: 'synced' },
      { key: 'c', id: 'c', type: 'transition', orderId: 'WO', stepId: 'S', idempotencyKey: 'k', queuedAt: '', status: 'failed' },
    ];
    expect(countPending(items)).toBe(2);
  });

  it('reads a snapshot from the stores', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    pending.values.set('a', {
      key: 'a',
      id: 'a',
      type: 'transition',
      orderId: 'WO',
      stepId: 'S',
      idempotencyKey: 'k',
      queuedAt: '',
      status: 'local',
    });
    const syncState = createMemoryStore<SyncState>();
    syncState.values.set('last-sync', {
      key: 'last-sync',
      value: '2026-01-01T00:00:00.000Z',
      updatedAt: '',
    });

    const snapshot = await readOfflineStatus(pending, syncState, true);
    expect(snapshot.online).toBe(true);
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('formats last sync time', () => {
    expect(formatLastSync(null)).toBe('从未同步');
    expect(formatLastSync('not-a-date')).toBe('从未同步');
    expect(formatLastSync(new Date().toISOString())).toBe('刚刚');
  });

  it('computes a next-retry time only for failed items', () => {
    const base = new StoredItemFactory();
    const failed = base.make({
      id: 'f1',
      status: 'failed',
      retryCount: 1,
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
    });
    const next = computeNextRetryAt(failed, Date.parse('2026-01-01T00:00:00.000Z'));
    expect(next).not.toBeNull();
    // Backoff(1) = [2000, 3000) ms after lastAttemptAt.
    const delta = new Date(next!).getTime() - Date.parse('2026-01-01T00:00:00.000Z');
    expect(delta).toBeGreaterThanOrEqual(2000);
    expect(delta).toBeLessThanOrEqual(3000);

    // Non-failed items never schedule a retry.
    expect(computeNextRetryAt(base.make({ id: 'ok', status: 'local' }))).toBeNull();
    expect(
      computeNextRetryAt(base.make({ id: 'conf', status: 'conflict', retryCount: 2 })),
    ).toBeNull();
  });

  it('flags stale data only when the last sync is older than the threshold', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(isDataStale(null, now)).toBe(false);
    expect(isDataStale('not-a-date', now)).toBe(false);
    // 6 minutes ago → stale (threshold 5 min).
    expect(
      isDataStale(new Date(now - 6 * 60_000).toISOString(), now),
    ).toBe(true);
    // 1 minute ago → fresh.
    expect(
      isDataStale(new Date(now - 60_000).toISOString(), now),
    ).toBe(false);
  });
});

class StoredItemFactory {
  make(overrides: Partial<StoredPendingAction>): StoredPendingAction {
    return {
      key: overrides.id ?? 'x',
      id: overrides.id ?? 'x',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      idempotencyKey: 'k',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'local',
      ...overrides,
    };
  }
}