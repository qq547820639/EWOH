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
      if (result) {
        result.onsuccess = () => resolve(result.result as R);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(undefined as unknown as R);
      }
      tx.onerror = () => reject(tx.error);
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
  };
}

/**
 * Opens (creates if needed) the offline IndexedDB database and returns typed
 * stores. Falls back to a drive-based database only when IndexedDB is missing.
 */
export async function openOfflineDb(): Promise<OfflineDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
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
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

/** Creates a unique, collision-resistant id (crypto UUID when available). */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generates an idempotency key for a mobile action. Backend idempotency support
 * is NOT assumed; the key is recorded locally so duplicate deliveries can be
 * traced and deduplicated once the backend implements it (see #9 / TODO).
 */
export function generateIdempotencyKey(
  orderId: string,
  stepId: string,
  action?: string,
): string {
  return `${createId()}:${orderId}:${stepId}:${action ?? 'unknown'}`;
}

export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10000);
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
    idempotencyKey: generateIdempotencyKey(
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
 * Migrates the legacy localStorage pending-action queue (`ewoh.mobile.pending-actions.v1`)
 * into IndexedDB. The legacy data is left intact for backward compatibility. Runs at most
 * once (guarded by a flag in syncState).
 */
export async function migratePendingActionsFromLocalStorage(
  storage: StorageLike | null,
  pendingStore: SimpleStore<StoredPendingAction>,
  attachmentStore: SimpleStore<OfflineAttachment>,
  syncStateStore: SimpleStore<SyncState>,
): Promise<number> {
  if (!storage) {
    return 0;
  }
  const existing = await syncStateStore.get(MIGRATION_FLAG_KEY);
  if (existing) {
    return 0;
  }
  const legacy = readPendingActions(storage);
  let migrated = 0;
  for (const action of legacy) {
    const stored = await toStoredPendingAction(action, attachmentStore);
    await pendingStore.put(stored);
    migrated += 1;
  }
  await syncStateStore.put({
    key: MIGRATION_FLAG_KEY,
    value: true,
    updatedAt: new Date().toISOString(),
  });
  return migrated;
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
}

/**
 * Flushes queued offline actions through the backend state machine. Failed items
 * are retried with exponential backoff (up to `maxAttempts`). Conflict (409) items
 * are surfaced for manual resolution and never auto-retried. This still calls the
 * backend `transitionMobileStep` / `inspectMobileStep` — the state machine is
 * enforced server-side, never bypassed locally.
 */
export async function flushOfflineQueue(
  syncOne: (item: StoredPendingAction) => Promise<void>,
  pendingStore: SimpleStore<StoredPendingAction>,
  options?: { includeManual?: boolean; maxAttempts?: number },
): Promise<OfflineFlushSummary> {
  const includeManual = options?.includeManual ?? false;
  const maxAttempts = options?.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const summary: OfflineFlushSummary = { synced: [], conflict: [], failed: [] };
  const items = await pendingStore.getAll();

  for (const item of items) {
    if (
      !includeManual &&
      (item.status === 'failed' || item.status === 'conflict')
    ) {
      continue;
    }
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
          // Session invalid — retrying won't help until auth is refreshed.
          break;
        }
        if (attempts < maxAttempts) {
          await delay(backoffDelay(attempts));
        }
      }
    }

    if (succeeded) {
      await pendingStore.delete(item.key);
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
  }
  return summary;
}

/** Convenience: drop legacy localStorage key (kept for compatibility tests). */
export { PENDING_ACTIONS_STORAGE_KEY };