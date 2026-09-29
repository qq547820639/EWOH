import {
  PENDING_ACTIONS_STORAGE_KEY,
  readPendingActions,
  isStateConflictError,
  pendingActionErrorMessage,
  type PendingActionError,
  type PendingActionStatus,
  type PendingMobileAction,
  type StorageLike,
} from './offlineQueue';
import { dataUrlToBlob } from './attachmentDataUrl';
import { parseConflictPayload } from './offlineConflict';

export const OFFLINE_DB_NAME = 'ewoh-offline';
export const OFFLINE_DB_VERSION = 1;

/**
 * Offline vaults contain worker-entered facts and photos, so they must never be
 * shared across login identities. Scope the database name by authenticated
 * org/user. A null scope is reserved for non-identity system probes only.
 */
export function offlineDbNameForScope(scopeKey?: string | null): string {
  const scope = scopeKey?.trim();
  return scope ? `${OFFLINE_DB_NAME}:${scope}` : OFFLINE_DB_NAME;
}

export const STORE_NAMES = {
  pendingActions: 'pendingActions',
  drafts: 'drafts',
  attachments: 'attachments',
  syncState: 'syncState',
  serverVersion: 'serverVersion',
  auditLog: 'auditLog',
} as const;

export const MIGRATION_FLAG_KEY = 'pending-migrated-v1';
export const LAST_SYNC_KEY = 'last-sync';
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * A minimal, store-agnostic abstraction over an IndexedDB object store.
 * Kept generic so callers can inject an in-memory fake in tests.
 */
export interface SimpleStore<T extends { key: string }> {
  getAll(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
  /**
   * CLI-519：可选的单事务批量删除（IDB 实现提供；内存 fake 可缺省，
   * 调用方需回退到逐条删除）。保证全部删除要么整体提交、要么整体回滚。
   */
  deleteMany?(keys: string[]): Promise<void>;
}

export interface StoredPendingAction {
  key: string;
  id: string;
  type: 'transition' | 'inspection';
  orderId: string;
  stepId: string;
  action?: string;
  body?: Record<string, unknown>;
  /** Reference to an OfflineAttachment record when an exception photo is attached. */
  attachmentId?: string;
  /** Idempotency key for safe re-delivery (see #9). */
  idempotencyKey: string;
  actorId?: string;
  queuedAt: string;
  status: PendingActionStatus;
  error?: PendingActionError;
  lastAttemptAt?: string;
  syncedAt?: string;
  retryCount?: number;
  /** Populated when a flush hits a STATE_CONFLICT (409) — carries the payload
   *  parsed from the server response for the local-vs-server diff UI. */
  conflict?: { localValue?: unknown; serverValue?: unknown };
}

export interface OfflineAttachment {
  key: string;
  id: string;
  name: string;
  contentType: string;
  /** Stored as a Blob (not a DataURL) to save space. */
  blob: Blob;
  size: number;
  createdAt: string;
}

export interface Draft {
  key: string;
  orderId: string;
  stepId: string;
  field: string;
  value: unknown;
  updatedAt: string;
}

export interface SyncState {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface ServerVersion {
  key: string;
  version: unknown;
  updatedAt: string;
}

export interface AuditLogEntry {
  key: string;
  at: string;
  actorId?: string;
  action: string;
  idempotencyKey: string;
  result: string;
  detail?: unknown;
}

export interface OfflineDatabase {
  pendingActions: SimpleStore<StoredPendingAction>;
  drafts: SimpleStore<Draft>;
  attachments: SimpleStore<OfflineAttachment>;
  syncState: SimpleStore<SyncState>;
  serverVersion: SimpleStore<ServerVersion>;
  auditLog: SimpleStore<AuditLogEntry>;
  /** Raw IndexedDB handle — used for multi-store atomic transactions. */
  db: IDBDatabase;
  close(): Promise<void>;
}

function createStore<T extends { key: string }>(
  db: IDBDatabase,
  storeName: string,
): SimpleStore<T> {
  const run = <R>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<R> | void): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const result = fn(tx);
      if (mode === 'readwrite') {
        // CLI-504：写事务以 tx.oncomplete 为准。请求 onsuccess 时事务仍
        // 可能随后中止/回滚（QuotaError、版本变更等），在请求成功即 resolve
        // 会让调用方误以为已持久化。请求结果（写操作均为 void）不再被消费。
        let requestError: DOMException | null = null;
        if (result) {
          result.onerror = () => {
            requestError = result.error;
          };
        }
        tx.oncomplete = () => resolve(undefined as unknown as R);
        tx.onerror = () => reject(tx.error ?? requestError);
        tx.onabort = () => reject(tx.error ?? requestError ?? new Error(`${storeName} transaction aborted`));
        return;
      }
      if (result) {
        result.onsuccess = () => resolve(result.result as R);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(undefined as unknown as R);
      }
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error(`${storeName} transaction aborted`));
    });

  return {
    getAll: () => run('readonly', (tx) => tx.objectStore(storeName).getAll()),
    get: (key) => run('readonly', (tx) => tx.objectStore(storeName).get(key)),
    put: (value) =>
      run('readwrite', (tx) => tx.objectStore(storeName).put(value)).then(
        () => undefined,
      ),
    delete: (key) => run('readwrite', (tx) => tx.objectStore(storeName).delete(key)),
    clear: () => run('readwrite', (tx) => tx.objectStore(storeName).clear()),
    count: () => run('readonly', (tx) => tx.objectStore(storeName).count()),
    // CLI-519：批量删除在单事务内执行（run 的 readwrite 路径以
    // tx.oncomplete resolve），整体原子。
    deleteMany: (keys: string[]) =>
      keys.length === 0
        ? Promise.resolve()
        : run('readwrite', (tx) => {
            const objectStore = tx.objectStore(storeName);
            for (const key of keys) {
              objectStore.delete(key);
            }
          }).then(() => undefined),
  };
}

/**
 * Opens (creates if needed) the offline IndexedDB database and returns typed
 * stores. Falls back to a drive-based database only when IndexedDB is missing.
 */
export async function openOfflineDb(scopeKey?: string | null): Promise<OfflineDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  const databaseName = offlineDbNameForScope(scopeKey);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const stores: Array<[string, string]> = [
        [STORE_NAMES.pendingActions, 'key'],
        [STORE_NAMES.drafts, 'key'],
        [STORE_NAMES.attachments, 'key'],
        [STORE_NAMES.syncState, 'key'],
        [STORE_NAMES.serverVersion, 'key'],
        [STORE_NAMES.auditLog, 'key'],
      ];
      for (const [name, keyPath] of stores) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath });
        }
      }
      // CLI-528（裁决）：IndexedDB 结构迁移（新增 store/索引）与业务数据
      // 迁移（localStorage → IndexedDB，见 migratePendingActionsFromLocalStorage）
      // 分两层执行：后者依赖打开后的 store 句柄与幂等 flag，且需处理
      // 无 legacy 数据的正常路径，放在 openOfflineDb 之后的启动序列中执行
      // （storageController.runMigrations）。在 upgradeneeded 事务内做跨
      // 存储读写的业务迁移无法满足这两点，故不在此处耦合。
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return {
    pendingActions: createStore<StoredPendingAction>(db, STORE_NAMES.pendingActions),
    drafts: createStore<Draft>(db, STORE_NAMES.drafts),
    attachments: createStore<OfflineAttachment>(db, STORE_NAMES.attachments),
    syncState: createStore<SyncState>(db, STORE_NAMES.syncState),
    serverVersion: createStore<ServerVersion>(db, STORE_NAMES.serverVersion),
    auditLog: createStore<AuditLogEntry>(db, STORE_NAMES.auditLog),
    db,
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

/**
 * Atomically writes a pending action and its attachment (when present) in a
 * SINGLE IndexedDB transaction. If either write fails, both are rolled back, so
 * an action is never persisted without its attachment (and vice-versa) — the
 * guarantee that prevents orphaned attachments from being created in the first
 * place.
 */
export async function savePendingActionWithAttachment(
  db: IDBDatabase,
  pending: StoredPendingAction,
  attachment?: OfflineAttachment,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_NAMES.pendingActions, STORE_NAMES.attachments],
      'readwrite',
    );
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    if (attachment) {
      tx.objectStore(STORE_NAMES.attachments).put(attachment);
    }
    tx.objectStore(STORE_NAMES.pendingActions).put(pending);
  });
}

/** Creates a unique, collision-resistant id (crypto UUID when available). */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * CLI-534：更名 generateTraceKey——该值由 createId() 生成、每次调用都不同，
 * 实际语义是「本次入队投递的追踪 ID」而非幂等键（幂等去重依赖 action.id）。
 * 字段名 idempotencyKey 为既有数据模型契约，保留不改。
 */
export function generateTraceKey(
  orderId: string,
  stepId: string,
  action?: string,
): string {
  return `${createId()}:${orderId}:${stepId}:${action ?? 'unknown'}`;
}

export function backoffDelay(attempt: number): number {
  // CLI-541：指数退避上限 10s 是「客户端自发重试」的节奏约束；
  // retryAfterMs 的 60s 上限服务于「服务端显式 Retry-After 指令」——
  // 服务端要求更长等待时尊重指令（两者来源与语义不同，故上限不同）。
  return Math.min(1000 * 2 ** attempt, 10000);
}

/**
 * 冲突项「采用本地」前的**载荷重建**：把排队时落库的附件重新上传，并把引用
 * 并入重放 payload。
 *
 * 为什么必须重建：离线异常提交时，附件引用只在 flush 投递瞬间由
 * `buildSyncOne` 临时合并进请求体，队列里的 `item.body` 从不包含它。若冲突
 * 解析直接拿 `item.body` 重放，重放的本地值会**静默丢掉现场照片**（且服务端
 * 侧留下孤儿上传文件）。附件缺失（已被清理）时如实按无附件重放，不编造。
 * upload 作为注入参数（不直接 import api/files）：本模块必须保持纯离线依赖，
 * 不沾 http/Vite 专属语法，否则 jest node 环境无法加载。
 */
export async function buildLocalResolvePayload(
  item: StoredPendingAction,
  attachmentStore: SimpleStore<OfflineAttachment> | null,
  upload: (
    file: File,
    note?: string,
  ) => Promise<{ id: string; filename: string; contentType: string }>,
): Promise<Record<string, unknown>> {
  const base = { ...(item.body ?? {}) };
  if (!item.attachmentId) return base;
  const attachment = attachmentStore ? await attachmentStore.get(item.attachmentId) : undefined;
  if (!attachment) return base;
  const file = new File([attachment.blob], attachment.name, {
    type: attachment.contentType,
  });
  const record = await upload(file, `exception-${item.stepId}`);
  return {
    ...base,
    attachments: [
      {
        id: record.id,
        filename: record.filename,
        contentType: record.contentType,
      },
    ],
  };
}

/**
 * Adds bounded random jitter to a base delay: `base + rnd(0, jitterMs)`. Jitter
 * de-synchronizes retries across many clients so they do not all retry at the
 * same instant (thundering herd). Pure and deterministic in its bounds so tests
 * can assert `[base, base + jitterMs)`.
 */
export function addJitter(base: number, jitterMs: number = 1000): number {
  return base + Math.floor(Math.random() * (jitterMs + 1));
}

/**
 * Retry backoff with jitter (requirement: exponential backoff + jitter + max
 * attempts + Retry-After). The base grows exponentially (capped at 10s) and a
 * capped random jitter is added so simultaneous flushers spread their retries.
 */
export function backoffDelayWithJitter(attempt: number, jitterMs: number = 1000): number {
  return addJitter(backoffDelay(attempt), jitterMs);
}

/**
 * Reads a `Retry-After` hint from a transient error and returns the backoff
 * delay in ms, or `null` when no hint is present (caller falls back to its own
 * exponential backoff). The HTTP `Retry-After` header is expressed in SECONDS;
 * the numeric `retryAfter` field some clients emit is treated as MILLISECONDS.
 */
export function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as {
    response?: { headers?: Record<string, unknown> };
    retryAfter?: unknown;
  };
  const headerVal =
    record.response?.headers?.['retry-after'] ??
    record.response?.headers?.['Retry-After'];
  if (headerVal !== undefined && headerVal !== null) {
    const seconds = Number(headerVal);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  if (record.retryAfter !== undefined && record.retryAfter !== null) {
    const ms = Number(record.retryAfter);
    if (Number.isFinite(ms) && ms >= 0) {
      return Math.min(ms, 60_000);
    }
  }
  return null;
}

/**
 * Distinguishes authentication/session failures (401, token expired) from
 * transient network errors. Auth failures are not worth retrying — the session
 * must be refreshed first — so the flush loop treats them as non-retryable.
 */
export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    response?: { status?: number };
    code?: string;
  };
  if (record.response?.status === 401) {
    return true;
  }
  if (record.code === 'TOKEN_EXPIRED' || record.code === 'AUTH_REQUIRED') {
    return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes('401') ||
      error.message.includes('TOKEN_EXPIRED') ||
      error.message.includes('Unauthorized')
    );
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toStoredPendingAction(
  action: PendingMobileAction,
  attachmentStore: SimpleStore<OfflineAttachment>,
): Promise<StoredPendingAction> {
  let attachmentId: string | undefined;
  if (action.attachment) {
    attachmentId = createId();
    const blob = dataUrlToBlob(action.attachment.dataUrl);
    await attachmentStore.put({
      key: attachmentId,
      id: attachmentId,
      name: action.attachment.name,
      contentType: action.attachment.contentType,
      blob,
      size: blob.size,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    key: action.id,
    id: action.id,
    type: action.type,
    orderId: action.orderId,
    stepId: action.stepId,
    action: action.action,
    body: action.body,
    attachmentId,
    idempotencyKey: generateTraceKey(
      action.orderId,
      action.stepId,
      action.action,
    ),
    queuedAt: action.queuedAt,
    status: action.status,
    error: action.error,
    lastAttemptAt: action.lastAttemptAt,
    syncedAt: action.syncedAt,
    retryCount: 0,
  };
}

/**
 * Legacy localStorage pending actions have no authenticated owner/org binding.
 * After offline vaults became identity-scoped, silently importing them into the
 * current user's vault would let worker A's queued facts/photos be flushed under
 * worker B's login. We therefore fail closed: preserve the legacy data, mark the
 * migration skipped, and never auto-delete evidence that may belong to someone
 * else. Recovery requires an explicit out-of-band owner review.
 */
export const LEGACY_MIGRATION_SKIPPED_KEY = 'legacy-migration-skipped-unattributed';

export async function migratePendingActionsFromLocalStorage(
  storage: StorageLike | null,
  pendingStore: SimpleStore<StoredPendingAction>,
  attachmentStore: SimpleStore<OfflineAttachment>,
  syncStateStore: SimpleStore<SyncState>,
): Promise<number> {
  void pendingStore;
  void attachmentStore;
  if (!storage) {
    return 0;
  }
  const existing = await syncStateStore.get(MIGRATION_FLAG_KEY);
  if (existing) {
    return 0;
  }
  // Read once only to establish whether unattributed evidence exists; do not
  // parse/convert it into the current identity's queue.
  const legacyCount = readPendingActions(storage).length;
  await syncStateStore.put({
    key: MIGRATION_FLAG_KEY,
    value: {
      skipped: true,
      reason: 'legacy_queue_has_no_owner_binding',
      legacyCount,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });
  return 0;
}

export async function getLastSyncAt(
  store: SimpleStore<SyncState>,
): Promise<string | null> {
  const record = await store.get(LAST_SYNC_KEY);
  return typeof record?.value === 'string' ? record.value : null;
}

export async function setLastSyncAt(
  store: SimpleStore<SyncState>,
  at?: string,
): Promise<void> {
  await store.put({
    key: LAST_SYNC_KEY,
    value: at ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export interface OfflineFlushSummary {
  synced: string[];
  conflict: string[];
  failed: string[];
  /** True when a 401/auth failure was hit — the queue should pause and guide re-auth. */
  authRequired?: boolean;
}

export interface OfflineFlushOptions {
  includeManual?: boolean;
  maxAttempts?: number;
  /** Bounded cross-entity concurrency (>=1). Items of the SAME entity stay serial. */
  concurrency?: number;
  /** When provided, the orphaned attachment is removed once its action completes. */
  attachmentStore?: SimpleStore<OfflineAttachment>;
  /** Restrict flushing to exactly these item ids (e.g. a user-selected batch). */
  onlyIds?: string[];
}

/**
 * Flushes queued offline actions through the backend state machine. Failed items
 * are retried with exponential backoff (up to `maxAttempts`), honoring a
 * `Retry-After` hint when the server sends one. Conflict (409) items are surfaced
 * for manual resolution and never auto-retried. Auth failures (401) mark the
 * queue as `authRequired` so the caller can pause and guide re-authentication.
 *
 * Execution guarantees:
 *   - Items of the same entity (orderId) run strictly in order (serial).
 *   - Different entities run concurrently, bounded by `options.concurrency`.
 *   - On success the queued action is removed and its orphaned attachment (if any)
 *     is cleaned up, so no orphan bytes are left behind after completion.
 */
export async function flushOfflineQueue(
  syncOne: (item: StoredPendingAction) => Promise<void>,
  pendingStore: SimpleStore<StoredPendingAction>,
  options?: OfflineFlushOptions,
): Promise<OfflineFlushSummary> {
  const includeManual = options?.includeManual ?? false;
  const maxAttempts = options?.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const concurrency = Math.max(1, options?.concurrency ?? 3);
  const attachmentStore = options?.attachmentStore;
  const onlyIds = options?.onlyIds;
  const summary: OfflineFlushSummary = {
    synced: [],
    conflict: [],
    failed: [],
  };

  const items = await pendingStore.getAll();
  const eligible = items.filter(
    (item) =>
      (onlyIds ? onlyIds.includes(item.id) : true) &&
      (includeManual ||
        // 401 失败项（AUTH_REQUIRED）：仅因会话失效而失败，重新登录后的自动
        // flush 必须重新投递——幂等键已持久化、重放安全，服务端状态机仍是权威。
        // 否则 UI 承诺的"重新登录后继续同步"永远不发生，用户只能逐条手动重试。
        // 业务失败（SYNC_ERROR / conflict）不受影响，仍需人工介入。
        item.error?.code === 'AUTH_REQUIRED' ||
        (item.status !== 'failed' && item.status !== 'conflict')),
  );

  // 回放顺序必须等于操作发生顺序（queuedAt 升序），而不是存储返回顺序：
  // IndexedDB 的 getAll 按主键（随机 UUID 字符串）排序，页面刷新/崩溃恢复后
  // 同一工单的 start→report 可能被乱序投递，后置动作会撞服务端状态机 409
  // （STATE_CONFLICT），把本来有效的操作序列变成假冲突。时间戳缺失/损坏时按
  // epoch 0 处理（排在最前，先投递早先入队的项）。
  const queuedAtMs = (iso: string): number => {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const ordered = eligible.slice().sort((a, b) => queuedAtMs(a.queuedAt) - queuedAtMs(b.queuedAt));

  // Group by entity so same-entity items stay serial; distinct entities can run
  // concurrently (bounded by `concurrency`).
  const groups = new Map<string, StoredPendingAction[]>();
  for (const item of ordered) {
    const entity = item.orderId || item.id;
    const list = groups.get(entity) ?? [];
    list.push(item);
    groups.set(entity, list);
  }
  const groupList = Array.from(groups.values());

  const syncItem = async (item: StoredPendingAction): Promise<void> => {
    await pendingStore.put({ ...item, status: 'syncing' });

    let lastError: unknown;
    let conflict = false;
    let succeeded = false;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        await syncOne(item);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        if (isStateConflictError(error)) {
          conflict = true;
          break;
        }
        if (isAuthError(error)) {
          summary.authRequired = true;
          break;
        }
        if (attempts < maxAttempts) {
          const wait = retryAfterMs(error) ?? backoffDelayWithJitter(attempts);
          await delay(wait);
        }
      }
    }

    if (succeeded) {
      await pendingStore.delete(item.key);
      // 完成即清理孤儿附件，避免成功后残留无效附件字节。
      if (item.attachmentId && attachmentStore) {
        await attachmentStore.delete(item.attachmentId);
      }
      summary.synced.push(item.id);
    } else if (conflict) {
      const payload = parseConflictPayload(lastError);
      await pendingStore.put({
        ...item,
        status: 'conflict',
        error: {
          code: 'STATE_CONFLICT',
          message: pendingActionErrorMessage(lastError),
          retryable: false,
        },
        conflict: payload
          ? { localValue: payload.localValue, serverValue: payload.serverValue }
          : item.conflict,
        lastAttemptAt: new Date().toISOString(),
      });
      summary.conflict.push(item.id);
    } else {
      const authFailure = isAuthError(lastError);
      await pendingStore.put({
        ...item,
        status: 'failed',
        retryCount: (item.retryCount ?? 0) + 1,
        error: {
          code: authFailure ? 'AUTH_REQUIRED' : 'SYNC_ERROR',
          message: pendingActionErrorMessage(lastError),
          retryable: !authFailure,
        },
        lastAttemptAt: new Date().toISOString(),
      });
      summary.failed.push(item.id);
    }
  };

  // Process each entity group serially; run up to `concurrency` groups in parallel.
  // CLI-522（裁决）：groupIndex 为共享游标——worker 依序取组，先取的组（大实体）
  // 持续占用 worker 时后续组仍会被其它 worker 取走，仅在「组数 > worker 数且
  // 前 N 个组耗时极长」时才出现尾组饥饿。如需严格公平可改为轮转取组
  // （round-robin：worker i 从 i % workers 起步按 workers 步进取组），
  // 当前队列规模（单用户移动端待同步项）下无实测饥饿，先记录不动。
  let groupIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, groupList.length) },
    async () => {
      while (groupIndex < groupList.length) {
        const group = groupList[groupIndex];
        groupIndex += 1;
        for (const item of group) {
          await syncItem(item);
        }
      }
    },
  );
  await Promise.all(workers);

  return summary;
}

/** Serializes a Blob to a base64 data URL (only used client-side for export). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') {
    // CLI-523：无 FileReader 的环境直接拒绝导出——返回空 data URL 会让导出
    // 快照静默丢失全部附件内容，且导入方无从感知。
    return Promise.reject(
      new Error('FileReader is not available; cannot serialize blob for export'),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Serialized snapshot of the offline vault for backup/export (attachments as
 *  data URLs so the whole export is a single JSON document). */
export interface OfflineExportSnapshot {
  schema: string;
  exportedAt: string;
  pendingActions: StoredPendingAction[];
  drafts: Draft[];
  attachments: Array<Omit<OfflineAttachment, 'blob'> & { dataUrl: string }>;
  syncState: SyncState[];
  serverVersion: ServerVersion[];
  auditLog: AuditLogEntry[];
}

/**
 * Exports the entire offline vault to a JSON snapshot so the user can back it
 * up before cleanup / recovery, or move it to another device. Pending actions
 * retain their idempotency keys so a re-imported queue can be re-delivered
 * safely without duplicate side effects. Pure and injectable for tests.
 */
export async function exportOfflineData(
  db: OfflineDatabase,
): Promise<OfflineExportSnapshot> {
  const [pendingActions, drafts, attachments, syncState, serverVersion, auditLog] =
    await Promise.all([
      db.pendingActions.getAll(),
      db.drafts.getAll(),
      db.attachments.getAll(),
      db.syncState.getAll(),
      db.serverVersion.getAll(),
      db.auditLog.getAll(),
    ]);
  const serializedAttachments = await Promise.all(
    attachments.map(async (att) => ({
      key: att.key,
      id: att.id,
      name: att.name,
      contentType: att.contentType,
      size: att.size,
      createdAt: att.createdAt,
      dataUrl: await blobToDataUrl(att.blob),
    })),
  );
  return {
    schema: 'ewoh.offline.export.v1',
    exportedAt: new Date().toISOString(),
    pendingActions,
    drafts,
    attachments: serializedAttachments,
    syncState,
    serverVersion,
    auditLog,
  };
}

/** Convenience: drop legacy localStorage key (kept for compatibility tests). */
export { PENDING_ACTIONS_STORAGE_KEY };
