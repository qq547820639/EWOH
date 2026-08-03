export interface PendingMobileAction {
  id: string;
  type: 'transition' | 'inspection';
  orderId: string;
  stepId: string;
  action?: string;
  body?: Record<string, unknown>;
  queuedAt: string;
}

export const PENDING_ACTIONS_STORAGE_KEY = 'ewoh.mobile.pending-actions.v1';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  return typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : null;
}

function isPendingAction(value: unknown): value is PendingMobileAction {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PendingMobileAction>;
  return (
    (candidate.type === 'transition' || candidate.type === 'inspection') &&
    typeof candidate.orderId === 'string' &&
    typeof candidate.stepId === 'string'
  );
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
    return Array.isArray(parsed) ? parsed.filter(isPendingAction) : [];
  } catch {
    return [];
  }
}

export function appendPendingAction(
  action: Omit<PendingMobileAction, 'id' | 'queuedAt'>,
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
  };
  const next = [...queue, entry];
  store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(next));
  return next;
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
