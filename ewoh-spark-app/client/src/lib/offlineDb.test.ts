import {
  addJitter,
  backoffDelay,
  backoffDelayWithJitter,
  exportOfflineData,
  flushOfflineQueue,
  generateTraceKey,
  isAuthError,
  migratePendingActionsFromLocalStorage,
  MIGRATION_FLAG_KEY,
  retryAfterMs,
  savePendingActionWithAttachment,
  type OfflineAttachment,
  type OfflineDatabase,
  type OfflineExportSnapshot,
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
    const key = generateTraceKey('WO-1', 'S1', 'report');
    expect(key).toContain('WO-1');
    expect(key).toContain('S1');
    expect(key).toContain('report');
    const other = generateTraceKey('WO-1', 'S1', 'report');
    expect(key).not.toBe(other);
  });

  it('backoffDelay grows exponentially and caps at 10s', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(10)).toBe(10000);
  });

  it('does not migrate unattributed legacy localStorage actions into an identity vault', async () => {
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

    expect(migrated).toBe(0);
    expect(await pending.count()).toBe(0);
    expect(attachments.values.size).toBe(0);
    // Legacy evidence is preserved for out-of-band owner review, not deleted.
    expect(storage.getItem(PENDING_ACTIONS_STORAGE_KEY)).toBeTruthy();
    const flag = await syncState.get(MIGRATION_FLAG_KEY);
    expect(flag?.value).toMatchObject({ skipped: true, reason: 'legacy_queue_has_no_owner_binding' });
    const second = await migratePendingActionsFromLocalStorage(
      storage,
      pending,
      attachments,
      syncState,
    );
    expect(second).toBe(0);
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

  // 攻击面 b：离线队列回放顺序。真实 IndexedDB 的 getAll 按**主键**（随机 UUID
  // 字符串）排序返回，而不是入队顺序。页面刷新/崩溃恢复后，同一工单的
  // start→report 若按主键序乱序投递，后置动作会撞服务端状态机 409
  // （STATE_CONFLICT），把本来有效的操作序列变成"假冲突"，逼用户手工处置。
  // 回放顺序必须等于操作发生顺序（queuedAt 升序），与存储返回顺序无关。
  it('flushOfflineQueue 按 queuedAt（FIFO）回放，不依赖存储返回顺序', async () => {
    const values = new Map<string, StoredPendingAction>();
    const pending: SimpleStore<StoredPendingAction> = {
      async getAll() {
        // 模拟 IDB 语义：按主键（key 字符串）升序返回。
        return Array.from(values.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
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
    // key='b-…' 的 start 先做（queuedAt 更早）；key='a-…' 的 report 后做。
    // 主键序会把 report 排在 start 之前——这正是真实 IDB 的返回顺序。
    const start: StoredPendingAction = {
      key: 'b-first-op',
      id: 'b-first-op',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'start',
      idempotencyKey: 'k-start',
      queuedAt: '2026-09-10T10:00:00.000Z',
      status: 'local',
    };
    const report: StoredPendingAction = {
      key: 'a-second-op',
      id: 'a-second-op',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-report',
      queuedAt: '2026-09-10T10:05:00.000Z',
      status: 'local',
    };
    await pending.put(report);
    await pending.put(start);

    const calls: string[] = [];
    const summary = await flushOfflineQueue(
      async (item) => {
        calls.push(item.action ?? '');
      },
      pending,
    );

    expect(calls).toEqual(['start', 'report']);
    expect(summary.synced).toEqual(['b-first-op', 'a-second-op']);
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

  it('re-login auto flush re-delivers AUTH_REQUIRED failures (but not business failures)', async () => {
    // 401 会话失效把队列项标成 failed(AUTH_REQUIRED)。UI 承诺"重新登录后继续
    // 同步"——自动 flush（不带 includeManual）必须重新投递这类项，否则用户只能
    // 逐条手动重试、承诺落空。业务失败（SYNC_ERROR）仍保持手动。
    const pending = createMemoryStore<StoredPendingAction>();
    await pending.put({
      key: 'auth-1',
      id: 'auth-1',
      type: 'transition',
      orderId: 'WO-2',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-a1',
      queuedAt: new Date().toISOString(),
      status: 'failed',
      error: { code: 'AUTH_REQUIRED', message: 'Request failed with status code 401', retryable: false },
      retryCount: 1,
    });
    await pending.put({
      key: 'biz-1',
      id: 'biz-1',
      type: 'transition',
      orderId: 'WO-2',
      stepId: 'S2',
      action: 'report',
      idempotencyKey: 'k-b1',
      queuedAt: new Date().toISOString(),
      status: 'failed',
      error: { code: 'SYNC_ERROR', message: 'boom', retryable: true },
    });

    const syncOne = jest.fn().mockResolvedValue(undefined);
    // 不传 includeManual —— 模拟重新登录后 online 事件触发的自动 flush。
    const summary = await flushOfflineQueue(syncOne, pending);

    expect(summary.synced).toEqual(['auth-1']);
    expect(summary.failed).toEqual([]);
    expect(syncOne).toHaveBeenCalledTimes(1);
    const remaining = await pending.getAll();
    expect(remaining.map((item) => item.id)).toEqual(['biz-1']);
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

  it('retryAfterMs parses Retry-After headers and numeric hints', () => {
    expect(
      retryAfterMs({ response: { headers: { 'retry-after': '2' } } }),
    ).toBe(2000);
    expect(
      retryAfterMs({ response: { headers: { 'Retry-After': '5' } } }),
    ).toBe(5000);
    expect(retryAfterMs({ retryAfter: 1500 })).toBe(1500);
    expect(retryAfterMs({ response: { status: 503 } })).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('nope')).toBeNull();
  });

  it('flushOfflineQueue cleans up the orphaned attachment on success', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    const attachments = createMemoryStore<OfflineAttachment>();
    await pending.put({
      key: 'att-1',
      id: 'att-1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      attachmentId: 'blob-1',
      idempotencyKey: 'k-att',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });
    await attachments.put({
      key: 'blob-1',
      id: 'blob-1',
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      blob: new Blob(['x']),
      size: 1,
      createdAt: new Date().toISOString(),
    });

    const syncOne = jest.fn().mockResolvedValue(undefined);
    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
      attachmentStore: attachments,
    });

    expect(summary.synced).toEqual(['att-1']);
    expect(await pending.count()).toBe(0);
    // Orphan attachment removed once the action completes.
    expect(attachments.values.size).toBe(0);
  });

  it('flushOfflineQueue surfaces authRequired when a 401 is hit (queue should pause)', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    await pending.put({
      key: 'qa',
      id: 'qa',
      type: 'inspection',
      orderId: 'WO-1',
      stepId: 'S1',
      idempotencyKey: 'k-qa',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });
    const syncOne = jest.fn().mockRejectedValue({ response: { status: 401 } });
    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
    });
    expect(summary.authRequired).toBe(true);
    expect(syncOne).toHaveBeenCalledTimes(1);
    const remaining = await pending.getAll();
    expect(remaining[0].error?.code).toBe('AUTH_REQUIRED');
  });

  it('keeps same-entity items serial and processes distinct entities concurrently', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    const activeEntities = new Set<string>();
    let serialViolation = false;
    let maxActiveEntities = 0;

    const make = (id: string, orderId: string): StoredPendingAction => ({
      key: id,
      id,
      type: 'transition',
      orderId,
      stepId: id,
      action: 'report',
      idempotencyKey: `k-${id}`,
      queuedAt: new Date().toISOString(),
      status: 'local',
    });
    // Same entity: WO-A (a1, a2) — must be strictly serial.
    // Distinct entity: WO-B (b1) — may overlap with WO-A.
    await pending.put(make('a1', 'WO-A'));
    await pending.put(make('a2', 'WO-A'));
    await pending.put(make('b1', 'WO-B'));

    const syncOne = jest.fn().mockImplementation(async (item: StoredPendingAction) => {
      // Two items of the SAME entity in flight at once is a serialization breach.
      if (activeEntities.has(item.orderId)) {
        serialViolation = true;
      }
      activeEntities.add(item.orderId);
      maxActiveEntities = Math.max(maxActiveEntities, activeEntities.size);
      await new Promise((r) => setTimeout(r, 2));
      activeEntities.delete(item.orderId);
    });

    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
      concurrency: 3,
    });

    expect(summary.synced.sort()).toEqual(['a1', 'a2', 'b1']);
    // Same-entity items never ran concurrently.
    expect(serialViolation).toBe(false);
    // Cross-entity concurrency actually happened (WO-A and WO-B overlapped).
    expect(maxActiveEntities).toBe(2);
  });

  it('preserves unattributed legacy localStorage data and never removes it automatically', async () => {
    const legacy = JSON.stringify([
      { id: 'legacy-clean', type: 'transition', orderId: 'WO-1', stepId: 'S1' },
    ]);
    const storage = createStorage({ [PENDING_ACTIONS_STORAGE_KEY]: legacy });

    const pending = createMemoryStore<StoredPendingAction>();
    const attachments = createMemoryStore<OfflineAttachment>();
    const syncState = createMemoryStore<SyncState>();

    const migrated = await migratePendingActionsFromLocalStorage(
      storage,
      pending,
      attachments,
      syncState,
    );
    expect(migrated).toBe(0);
    expect(storage.getItem(PENDING_ACTIONS_STORAGE_KEY)).toBe(legacy);
    expect(await pending.count()).toBe(0);
  });

  it('savePendingActionWithAttachment writes action + attachment in one transaction', async () => {
    const storesHit: string[] = [];
    const tx = {
      oncomplete: (() => undefined) as (() => void) | null,
      onabort: null,
      onerror: null,
      objectStore(name: string) {
        storesHit.push(name);
        return { put: () => undefined };
      },
    };
    const fakeDb = {
      transaction(storeList: string[], mode: string) {
        expect(mode).toBe('readwrite');
        expect(storeList).toEqual(['pendingActions', 'attachments']);
        // Simulate the transaction committing after puts are issued.
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      },
    } as unknown as IDBDatabase;

    const pending: StoredPendingAction = {
      key: 'p1',
      id: 'p1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-p1',
      queuedAt: new Date().toISOString(),
      status: 'local',
    };
    const attachment: OfflineAttachment = {
      key: 'blob-1',
      id: 'blob-1',
      name: 'p.jpg',
      contentType: 'image/jpeg',
      blob: new Blob(['x']),
      size: 1,
      createdAt: new Date().toISOString(),
    };

    await savePendingActionWithAttachment(fakeDb, pending, attachment);
    // Both stores written within the SAME transaction.
    expect(storesHit).toEqual(['attachments', 'pendingActions']);
  });

  it('backoffDelayWithJitter stays within [base, base + jitter] bounds', () => {
    for (let i = 0; i < 200; i += 1) {
      const base = backoffDelay(1); // 2000
      const value = backoffDelayWithJitter(1, 500);
      expect(value).toBeGreaterThanOrEqual(base);
      expect(value).toBeLessThanOrEqual(base + 500);
    }
    // addJitter(0) returns exactly 0 (no jitter requested).
    expect(addJitter(100, 0)).toBe(100);
  });

  it('exportOfflineData serializes the whole vault with attachments as data URLs', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    const attachments = createMemoryStore<OfflineAttachment>();
    const drafts = createMemoryStore<{ key: string; orderId: string }>();
    const syncState = createMemoryStore<SyncState>();
    const serverVersion = createMemoryStore<{ key: string; version: unknown }>();
    const auditLog = createMemoryStore<{ key: string; at: string }>();

    await pending.put({
      key: 'e1',
      id: 'e1',
      type: 'inspection',
      orderId: 'WO-1',
      stepId: 'S1',
      idempotencyKey: 'k-export',
      queuedAt: new Date().toISOString(),
      status: 'local',
    });
    await attachments.put({
      key: 'blob-e',
      id: 'blob-e',
      name: 'p.jpg',
      contentType: 'image/jpeg',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      size: 1,
      createdAt: new Date().toISOString(),
    });
    await drafts.put({ key: 'd1', orderId: 'WO-1' });
    await syncState.put({ key: 'ss1', value: true, updatedAt: new Date().toISOString() });
    await serverVersion.put({ key: 'sv1', version: '1.0.0' });
    await auditLog.put({ key: 'a1', at: new Date().toISOString() });

    const db = {
      pendingActions: pending,
      drafts,
      attachments,
      syncState,
      serverVersion,
      auditLog,
    } as unknown as OfflineDatabase;

    // CLI-523：无 FileReader 的环境导出附件会显式拒绝（不再静默产出空
    // data URL）。本用例注入最小 FileReader stub 以验证正常序列化路径。
    class FileReaderStub {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob): void {
        void blob.text().then((text) => {
          this.result = `data:image/jpeg;base64,${btoa(text)}`;
          this.onload?.();
        });
      }
    }
    const globalWithReader = globalThis as unknown as { FileReader?: unknown };
    const originalReader = globalWithReader.FileReader;
    globalWithReader.FileReader = FileReaderStub;
    try {
      const snapshot = await exportOfflineData(db);
      expect(snapshot.schema).toBe('ewoh.offline.export.v1');
      expect(snapshot.pendingActions).toHaveLength(1);
      expect(snapshot.pendingActions[0].idempotencyKey).toBe('k-export');
      expect(snapshot.attachments).toHaveLength(1);
      // Blob converted to a data URL so the export is a single JSON document.
      expect(snapshot.attachments[0].dataUrl).toContain('data:image/jpeg');
      expect(snapshot.drafts).toHaveLength(1);
      expect(snapshot.syncState).toHaveLength(1);
      expect(snapshot.serverVersion).toHaveLength(1);
      expect(snapshot.auditLog).toHaveLength(1);
    } finally {
      globalWithReader.FileReader = originalReader;
    }
  });

  it('repeated clicks queue distinct idempotency keys (no collision for duplicate actions)', async () => {
    const keyA = generateTraceKey('WO-1', 'S1', 'report');
    const keyB = generateTraceKey('WO-1', 'S1', 'report');
    // Two rapid identical clicks still produce unique keys so the backend can
    // dedupe correctly instead of the second overwriting the first.
    expect(keyA).not.toBe(keyB);
    expect(keyA.split(':')).toHaveLength(4);
  });

  it('re-flushes items left in syncing status after a browser crash / device restart', async () => {
    const pending = createMemoryStore<StoredPendingAction>();
    // A crash/restart leaves an item stuck in 'syncing' (the flush never got to
    // delete it). On restart the queue must re-deliver it idempotently.
    await pending.put({
      key: 'crash1',
      id: 'crash1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-crash',
      queuedAt: new Date().toISOString(),
      status: 'syncing',
    });

    const syncOne = jest.fn().mockResolvedValue(undefined);
    const summary = await flushOfflineQueue(syncOne, pending, {
      includeManual: true,
    });
    // The syncing (orphaned-by-crash) item is picked up and delivered.
    expect(summary.synced).toEqual(['crash1']);
    expect(syncOne).toHaveBeenCalledTimes(1);
    expect(await pending.count()).toBe(0);
  });

  it('savePendingActionWithAttachment rolls back BOTH stores when the transaction aborts', async () => {
    const writes: string[] = [];
    const tx = {
      oncomplete: null,
      onabort: null,
      onerror: null,
      error: new Error('quota exceeded'),
      objectStore(name: string) {
        writes.push(name);
        return { put: () => undefined };
      },
    };
    const fakeDb = {
      transaction() {
        // Simulate an attachment-write failure causing the transaction to abort.
        setTimeout(() => {
          tx.onabort?.();
        }, 0);
        return tx;
      },
    } as unknown as IDBDatabase;

    const pending: StoredPendingAction = {
      key: 'rollback-1',
      id: 'rollback-1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S1',
      action: 'report',
      idempotencyKey: 'k-rollback',
      queuedAt: new Date().toISOString(),
      status: 'local',
    };
    const attachment: OfflineAttachment = {
      key: 'blob-r',
      id: 'blob-r',
      name: 'p.jpg',
      contentType: 'image/jpeg',
      blob: new Blob(['x']),
      size: 1,
      createdAt: new Date().toISOString(),
    };

    await expect(
      savePendingActionWithAttachment(fakeDb, pending, attachment),
    ).rejects.toBeTruthy();
    // Both stores were addressed in the same tx; neither is committed since
    // the tx aborted (the caller's writes are rolled back atomically).
    expect(writes).toEqual(['attachments', 'pendingActions']);
  });
});