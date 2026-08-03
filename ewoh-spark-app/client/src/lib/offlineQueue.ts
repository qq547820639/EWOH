export const PENDING_ACTION_STATUSES = [
  'local',
  'queued',
  'syncing',
  'synced',
  'failed',
  'conflict',
] as const;

export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export interface PendingActionError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface PendingMobileAction {
  id: string;
  type: 'transition' | 'inspection';
  orderId: string;
  stepId: string;
  action?: string;
  body?: Record<string, unknown>;
  attachment?: {
    name: string;
    contentType: string;
    dataUrl: string;
  };
  queuedAt: string;
  status: PendingActionStatus;
  error?: PendingActionError;
  lastAttemptAt?: string;
  syncedAt?: string;
}

export const PENDING_ACTIONS_STORAGE_KEY = 'ewoh.mobile.pending-actions.v1';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  return typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : null;
}

function normalizePendingAction(value: unknown): PendingMobileAction | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<PendingMobileAction>;
  if (
    (candidate.type !== 'transition' && candidate.type !== 'inspection') ||
    typeof candidate.orderId !== 'string' ||
    typeof candidate.stepId !== 'string'
  ) {
    return null;
  }
  if (
    candidate.status !== undefined &&
    !PENDING_ACTION_STATUSES.includes(candidate.status as PendingActionStatus)
  ) {
    return null;
  }
  return {
    ...(value as PendingMobileAction),
    status: candidate.status ?? 'local',
  };
}

export function readPendingActions(storage?: StorageLike): PendingMobileAction[] {
  const store = storage ?? defaultStorage();
  if (!store) {
    return [];
  }
  try {
    const raw = store.getItem(PENDING_ACTIONS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .map(normalizePendingAction)
          .filter((action): action is PendingMobileAction => action !== null)
      : [];
  } catch {
    return [];
  }
}

export function appendPendingAction(
  action: Omit<PendingMobileAction, 'id' | 'queuedAt' | 'status'>,
  storage?: StorageLike,
): PendingMobileAction[] {
  const store = storage ?? defaultStorage();
  if (!store) {
    return readPendingActions(store);
  }
  const queue = readPendingActions(store);
  const entry: PendingMobileAction = {
    ...action,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    queuedAt: new Date().toISOString(),
    status: 'local',
  };
  const next = [...queue, entry];
  store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function updatePendingAction(
  id: string,
  patch: Partial<Omit<PendingMobileAction, 'id'>>,
  storage?: StorageLike,
): PendingMobileAction[] {
  const store = storage ?? defaultStorage();
  if (!store) {
    return readPendingActions(store);
  }
  const queue = readPendingActions(store);
  const next = queue.map((action) =>
    action.id === id ? { ...action, ...patch, id: action.id } : action,
  );
  store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function markPendingAction(
  id: string,
  status: PendingActionStatus,
  error?: PendingActionError,
  storage?: StorageLike,
): PendingMobileAction[] {
  const attemptedAt = new Date().toISOString();
  const patch: Partial<Omit<PendingMobileAction, 'id'>> = {
    status,
    lastAttemptAt: attemptedAt,
    ...(status === 'synced'
      ? { syncedAt: attemptedAt, error: undefined }
      : {}),
    ...(status === 'local' || status === 'queued' || status === 'syncing'
      ? { error: undefined }
      : {}),
    ...(error ? { error } : {}),
  };
  return updatePendingAction(id, patch, storage);
}

export function removePendingAction(
  id: string,
  storage?: StorageLike,
): PendingMobileAction[] {
  const store = storage ?? defaultStorage();
  if (!store) {
    return readPendingActions(store);
  }
  const queue = readPendingActions(store);
  const next = queue.filter((action) => action.id !== id);
  store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearPendingActions(storage?: StorageLike): PendingMobileAction[] {
  const store = storage ?? defaultStorage();
  if (store) {
    store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify([]));
  }
  return [];
}

export function isStateConflictError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes('STATE_CONFLICT')) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    response?: { status?: number; data?: { message?: unknown } };
  };
  if (record.response?.status === 409) {
    return true;
  }
  const responseMessage = record.response?.data?.message;
  return (
    typeof responseMessage === 'string' &&
    responseMessage.includes('STATE_CONFLICT')
  );
}

export function pendingActionErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const record = error as { response?: { data?: { message?: unknown } } };
    const message = record.response?.data?.message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  return '同步失败，请重试';
}

export interface PendingActionSyncSummary {
  synced: string[];
  conflict: string[];
  failed: string[];
}

export async function flushPendingQueue(
  syncOne: (item: PendingMobileAction) => Promise<void>,
  queue: PendingMobileAction[],
  storage?: StorageLike,
): Promise<PendingActionSyncSummary> {
  const summary: PendingActionSyncSummary = {
    synced: [],
    conflict: [],
    failed: [],
  };
  for (const item of queue) {
    markPendingAction(item.id, 'syncing', undefined, storage);
    try {
      await syncOne(item);
      removePendingAction(item.id, storage);
      summary.synced.push(item.id);
    } catch (error) {
      if (isStateConflictError(error)) {
        markPendingAction(
          item.id,
          'conflict',
          {
            code: 'STATE_CONFLICT',
            message: pendingActionErrorMessage(error),
            retryable: true,
          },
          storage,
        );
        summary.conflict.push(item.id);
      } else {
        markPendingAction(
          item.id,
          'failed',
          {
            code: 'SYNC_ERROR',
            message: pendingActionErrorMessage(error),
            retryable: true,
          },
          storage,
        );
        summary.failed.push(item.id);
      }
    }
  }
  return summary;
}
