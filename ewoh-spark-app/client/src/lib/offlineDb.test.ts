import {
  backoffDelay,
  flushOfflineQueue,
  generateIdempotencyKey,
  isAuthError,
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

  it('detects auth failures so the flush loop does not retry them', () => {
    expect(isAuthError({ response: { status: 401 } })).toBe(true);
    expect(isAuthError({ code: 'TOKEN_EXPIRED' })).toBe(true);
    expect(isAuthError(new Error('Unauthorized'))).toBe(true);
    expect(isAuthError(new Error('network down'))).toBe(false);
    expect(isAuthError({ response: { status: 503 } })).toBe(false);
  });

  it('flushOfflineQueue marks auth failures non-retryable (AUTH_REQUIRED)', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    await pending.put({
      key: 'auth',
      id: 'auth',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-auth',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });

    const syncOne = jest.fn().mockRejectedValue({ response: { status: 401 } });
    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
      maxAttempts: 3,
    });

    // Auth errors break out of the retry loop immediately (no backoff retries).
    expect(syncOne).toHaveBeenCalledTimes(1);
    expect(summary.failed).toEqual(['auth']);
    const remaining = await pending.getAll();
    expect(remaining[0].status).toBe('failed');
    expect(remaining[0].error?.code).toBe('AUTH_REQUIRED');
    expect(remaining[0].error?.retryable).toBe(false);
  });

  it('queued items restore after a reload (re-hydration from persisted store)', async () => {
    // Two store handles over the SAME backing map simulate a page reload: data
    // written through handle A is read back through a fresh handle B.
    const values = new Map<string, StoredPendingAction>();
    const makeHandle = (): SimpleStore<StoredPendingAction> => ({
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
    });

    const beforeReload = makeHandle();
    const queued: StoredPendingAction[] = [
      {
        key: 'q1',
        id: 'q1',
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S1',
        action: 'start',
        idempotencyKey: 'k-q1',
        queuedAt: new Date().toISOString(),
        status: 'local',
      },
      {
        key: 'q2',
        id: 'q2',
        type: 'inspection',
        orderId: 'WO-1',
        stepId: 'S2',
        body: { result: 'pass' },
        idempotencyKey: 'k-q2',
        queuedAt: new Date().toISOString(),
        status: 'failed',
        error: { code: 'SYNC_ERROR', retryable: true, message: 'boom' },
        retryCount: 1,
      },
    ];
    for (const item of queued) {
      await beforeReload.put(item);
    }

    // A brand-new handle (as if the app restarted) reads the same persisted data.
    const afterReload = makeHandle();
    const restored = await afterReload.getAll();
    expect(restored).toHaveLength(2);
    expect(restored.map((i) => i.id)).toEqual(['q1', 'q2']);
    // Status/error/retry state survives the reload so manual retry still works.
    const q2 = restored.find((i) => i.id === 'q2');
    expect(q2?.status).toBe('failed');
    expect(q2?.error?.retryable).toBe(true);
    expect(q2?.retryCount).toBe(1);
  });

  it('restored queued items flush to success after reload (weak-network retry)', async () => {
    const values = new Map<string, StoredPendingAction>();
    const store = {
      async getAll() {
        return Array.from(values.values());
      },
      async get(key: string) {
        return values.get(key);
      },
      async put(value: StoredPendingAction) {
        values.set(value.key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
      async clear() {
        values.clear();
      },
      async count() {
        return values.size;
      },
    };
    await store.put({
      key: 'r1',
      id: 'r1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-r1',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });

    // Weak network: first attempt fails, transient retry succeeds.
    const syncOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);
    const summary = await flushOfflineQueue(syncOne, store, {
      includeManual: true,
    });
    expect(summary.synced).toEqual(['r1']);
    expect(syncOne).toHaveBeenCalledTimes(2);
    expect(await store.count()).toBe(0);
  });
});