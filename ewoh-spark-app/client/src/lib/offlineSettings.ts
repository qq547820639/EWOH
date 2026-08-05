/**
 * Per-user + per-device workbench settings persistence (Task 6 requirement 8).
 *
 * Scan / touch / one-hand / glove-mode settings are stored under a key that
 * scopes by BOTH the user and the device, so two users on the same device (or
 * the same user on two devices) never leak preferences into each other.
 */

export interface WorkbenchSettings {
  /** Scan input mode: 'scanner' | 'camera' | 'manual'. */
  scanMode?: 'scanner' | 'camera' | 'manual';
  /** Raise touch-target sizes for finger usage. */
  touchMode?: boolean;
  /** One-hand friendly layout (bottom-anchored controls). */
  oneHandMode?: boolean;
  /** Glove-friendly: larger controls, no fine-precision gestures. */
  gloveMode?: boolean;
}

export const SETTINGS_PREFIX = 'ewoh.mobile.settings';

/** Stable device id persisted once per browser/device. */
export function getDeviceId(storage: StorageLike = defaultStorage()): string {
  const KEY = `${SETTINGS_PREFIX}.device-id`;
  if (!storage) {
    return 'unknown-device';
  }
  let id = storage.getItem(KEY);
  if (!id) {
    id = createId();
    storage.setItem(KEY, id);
  }
  return id;
}

/** Storage-scoped settings key: prefix.userId.deviceId. */
export function settingsKey(userId: string, deviceId: string): string {
  return `${SETTINGS_PREFIX}.${userId}.${deviceId}`;
}

export function readSettings(
  userId: string,
  storage: StorageLike = defaultStorage(),
): WorkbenchSettings {
  if (!storage) {
    return {};
  }
  const raw = storage.getItem(settingsKey(userId, getDeviceId(storage)));
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as WorkbenchSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSettings(
  userId: string,
  patch: WorkbenchSettings,
  storage: StorageLike = defaultStorage(),
): WorkbenchSettings {
  if (!storage) {
    return patch;
  }
  const next: WorkbenchSettings = { ...readSettings(userId, storage), ...patch };
  storage.setItem(settingsKey(userId, getDeviceId(storage)), JSON.stringify(next));
  return next;
}

export function clearSettings(userId: string, storage: StorageLike = defaultStorage()): void {
  if (!storage) {
    return;
  }
  storage.removeItem?.(settingsKey(userId, getDeviceId(storage)));
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & {
  removeItem?: (key: string) => void;
};

function defaultStorage(): StorageLike | null {
  return typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : null;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}