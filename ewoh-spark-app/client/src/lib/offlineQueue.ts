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
  const status =
    candidate.status !== undefined &&
    PENDING_ACTION_STATUSES.includes(candidate.status as PendingActionStatus)
      ? candidate.status
      : 'local';
  // CLI-531：白名单字段拷贝——持久化 JSON 可能被篡改/含未知字段，直接
  // spread 会把任意多余字段透传进队列并在后续写入扩散。
  return {
    id: typeof candidate.id === 'string' ? candidate.id : '',
    type: candidate.type,
    orderId: candidate.orderId,
    stepId: candidate.stepId,
    action: typeof candidate.action === 'string' ? candidate.action : undefined,
    body:
      candidate.body && typeof candidate.body === 'object'
        ? (candidate.body as Record<string, unknown>)
        : undefined,
    attachment:
      candidate.attachment &&
      typeof candidate.attachment === 'object' &&
      typeof candidate.attachment.dataUrl === 'string'
        ? {
            name: typeof candidate.attachment.name === 'string' ? candidate.attachment.name : '',
            contentType:
              typeof candidate.attachment.contentType === 'string'
                ? candidate.attachment.contentType
                : 'application/octet-stream',
            dataUrl: candidate.attachment.dataUrl,
          }
        : undefined,
    queuedAt:
      typeof candidate.queuedAt === 'string'
        ? candidate.queuedAt
        : new Date(0).toISOString(),
    status: status as PendingActionStatus,
    error:
      candidate.error && typeof candidate.error === 'object'
        ? {
            code: typeof candidate.error.code === 'string' ? candidate.error.code : undefined,
            message:
              typeof candidate.error.message === 'string' ? candidate.error.message : undefined,
            retryable:
              typeof candidate.error.retryable === 'boolean' ? candidate.error.retryable : undefined,
          }
        : undefined,
    lastAttemptAt:
      typeof candidate.lastAttemptAt === 'string' ? candidate.lastAttemptAt : undefined,
    syncedAt: typeof candidate.syncedAt === 'string' ? candidate.syncedAt : undefined,
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
  // CLI-510：Math.random 生成的队列 id 快速连续入队可能碰撞，改用
  // crypto.randomUUID；环境不支持时抛错拒绝入队（队列 id 冲突会吞动作）。
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is not available; refusing to queue action');
  }
  const entry: PendingMobileAction = {
    ...action,
    id: crypto.randomUUID(),
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
  options: { includeManual?: boolean } = {},
): Promise<PendingActionSyncSummary> {
  const summary: PendingActionSyncSummary = {
    synced: [],
    conflict: [],
    failed: [],
  };
  // CLI-511：单份内存权威副本 + 每步整体写回——原实现每次 mark/remove 都
  // 全量 read+parse+stringify（O(n²) 序列化）。语义不变：每步后存储仍与
  // 状态一致，中断时已处理条目的结果已落盘。
  const store = storage ?? defaultStorage();
  let current: PendingMobileAction[] = [...queue];
  const write = (next: PendingMobileAction[]): void => {
    current = next;
    if (store) {
      store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(next));
    }
  };
  const patchAt = (
    id: string,
    patch: Partial<Omit<PendingMobileAction, 'id'>>,
  ): void => {
    write(current.map((action) => (action.id === id ? { ...action, ...patch, id } : action)));
  };
  for (const item of queue) {
    if (
      !options.includeManual &&
      (item.status === 'failed' || item.status === 'conflict')
    ) {
      continue;
    }
    const attemptedAt = new Date().toISOString();
    patchAt(item.id, { status: 'syncing', lastAttemptAt: attemptedAt, error: undefined });
    try {
      await syncOne(item);
      write(current.filter((action) => action.id !== item.id));
      summary.synced.push(item.id);
    } catch (error) {
      if (isStateConflictError(error)) {
        patchAt(item.id, {
          status: 'conflict',
          lastAttemptAt: attemptedAt,
          error: {
            code: 'STATE_CONFLICT',
            message: pendingActionErrorMessage(error),
            retryable: false,
          },
        });
        summary.conflict.push(item.id);
      } else {
        patchAt(item.id, {
          status: 'failed',
          lastAttemptAt: attemptedAt,
          error: {
            code: 'SYNC_ERROR',
            message: pendingActionErrorMessage(error),
            retryable: true,
          },
        });
        summary.failed.push(item.id);
      }
    }
  }
  return summary;
}
