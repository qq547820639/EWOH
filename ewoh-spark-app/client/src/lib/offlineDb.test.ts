import {
  backoffDelay,
  flushOfflineQueue,
  generateIdempotencyKey,
  migratePendingActionsFromLocalStorage,
  MIGRATION_FLAG_KEY,
  type OfflineAttachment,
  type SimpleStore,
  type StoredPendingAction,
  type SyncState,
} from './offlineDb';
import { PENDING_ACTIONS_STORAGE_KEY, type StorageLike } from './offlineQueue';

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

function createStorage(initial: Record<string, string> = {}): StorageLike {
  const values = { ...initial };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

describe('offlineDb', () => {
  it('generates idempotency keys that carry orderId/stepId/action', () => {
    const key = generateIdempotencyKey('WO-1', 'S1', 'report');
    expect(key).toContain('WO-1');
    expect(key).toContain('S1');
    expect(key).toContain('report');
    const other = generateIdempotencyKey('WO-1', 'S1', 'report');
    expect(key).not.toBe(other);
  });

  it('backoffDelay grows exponentially and caps at 10s', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(10)).toBe(10000);
  });

  it('migrates legacy localStorage pending actions into IndexedDB once', async () => {
    const storage = createStorage({
      [PENDING_ACTIONS_STORAGE_KEY]: JSON.stringify([
        {
          id: 'legacy-1',
          type: 'transition',
          orderId: 'WO-1',
          stepId: 'S1',
          action: 'start',
          attachment: {
            name: 'photo.jpg',
            contentType: 'image/jpeg',
            dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
          },
        },
        {
          id: 'legacy-2',
          type: 'inspection',
          orderId: 'WO-1',
          stepId: 'S2',
          body: { result: 'pass' },
        },
      ]),
    });

    const pending = createMemoryStore<StoredPendingAction>();
    const attachments = createMemoryStore<OfflineAttachment>();
    const syncState = createMemoryStore<SyncState>();

    const migrated = await migratePendingActionsFromLocalStorage(
      storage,
      pending,
      attachments,
      syncState,
    );

    expect(migrated).toBe(2);
    const all = await pending.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].idempotencyKey).toBeDefined();
    // Attachment photo converted to a Blob and stored in the attachment store.
    expect(all[0].attachmentId).toBeDefined();
    expect(attachments.values.size).toBe(1);
    const attachment = Array.from(attachments.values.values())[0];
    expect(attachment.blob.type).toBe('image/jpeg');

    // Second run is a no-op (flag set).
    const second = await migratePendingActionsFromLocalStorage(
      storage,
      pending,
      attachments,
      syncState,
    );
    expect(second).toBe(0);
    expect(await pending.count()).toBe(2);
    expect(await syncState.get(MIGRATION_FLAG_KEY)).toBeDefined();
  });

  it('flushOfflineQueue retries transient failures with backoff and removes on success', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    const item: StoredPendingAction = {
      key: 'a',
      id: 'a',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-1',
      queuedAt: new Date().toISOString(),
      status: 'local',
    };
    await pending.put(item);

    const syncOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);

    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
    });

    expect(summary.synced).toEqual(['a']);
    expect(syncOne).toHaveBeenCalledTimes(2);
    expect(await pending.count()).toBe(0);
  });

  it('flushOfflineQueue surfaces conflicts and does not retry them', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    await pending.put({
      key: 'c',
      id: 'c',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-2',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });

    const syncOne = jest.fn().mockRejectedValue({
      response: { status: 409, data: { message: 'STATE_CONFLICT' } },
    });

    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
    });

    expect(summary.conflict).toEqual(['c']);
    expect(syncOne).toHaveBeenCalledTimes(1);
    const remaining = await pending.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('conflict');
    expect(remaining[0].error?.code).toBe('STATE_CONFLICT');
  });

  it('flushOfflineQueue marks failed items and enforces retry count', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    await pending.put({
      key: 'f',
      id: 'f',
      type: 'inspection',
      orderId: 'WO-1',
      stepId: 'S1',
      idempotencyKey: 'k-3',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });

    const syncOne = jest.fn().mockRejectedValue(new Error('boom'));
    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
      maxAttempts: 2,
    });

    expect(summary.failed).toEqual(['f']);
    expect(syncOne).toHaveBeenCalledTimes(2);
    const remaining = await pending.getAll();
    expect(remaining[0].status).toBe('failed');
    expect(remaining[0].retryCount).toBe(1);
  });
});