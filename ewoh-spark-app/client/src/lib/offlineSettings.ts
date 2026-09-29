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

/**
 * Stable device id persisted once per browser/device.
 *
 * CLI-545（裁决）：清缓存后 localStorage 中的 deviceId 一并清空、重新生成，
 * 旧设置键因此孤立——按设计可接受：deviceId 本就是设备级本地标识而非账号
 * 数据，清理站点数据后视作「新设备」符合用户预期；孤立键由浏览器存储
 * 配额自然淘汰，不做迁移。
 */
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
function encodeStorageSegment(value: string): string {
  // User ids and device ids are untrusted storage key fragments. Encoding the
  // delimiters prevents "a.b" + "c" from colliding with "a" + "b.c".
  // encodeURIComponent intentionally leaves "." unchanged; encode it too because
  // it is our storage-key delimiter.
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

export function settingsKey(userId: string, deviceId: string): string {
  return `${SETTINGS_PREFIX}.${encodeStorageSegment(userId)}.${encodeStorageSegment(deviceId)}`;
}

const SCAN_MODES = new Set(['scanner', 'camera', 'manual']);

function sanitizeSettings(value: unknown): WorkbenchSettings {
  // JSON.parse can revive attacker-controlled storage shapes, including
  // __proto__-shaped payloads. Keep an allow-list and reject unknown fields so
  // preferences cannot become a prototype-pollution or type-confusion vector.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: WorkbenchSettings = {};
  if (typeof input.touchMode === 'boolean') output.touchMode = input.touchMode;
  if (typeof input.oneHandMode === 'boolean') output.oneHandMode = input.oneHandMode;
  if (typeof input.gloveMode === 'boolean') output.gloveMode = input.gloveMode;
  if (typeof input.scanMode === 'string' && SCAN_MODES.has(input.scanMode)) {
    output.scanMode = input.scanMode as WorkbenchSettings['scanMode'];
  }
  return output;
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
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveSettings(
  userId: string,
  patch: WorkbenchSettings,
  storage: StorageLike = defaultStorage(),
): WorkbenchSettings {
  const safePatch = sanitizeSettings(patch);
  if (!storage) {
    return safePatch;
  }
  const next: WorkbenchSettings = {
    ...readSettings(userId, storage),
    ...safePatch,
  };
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