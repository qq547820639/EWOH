import { countPending, formatLastSync, readOfflineStatus } from './offlineStatus';
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
});