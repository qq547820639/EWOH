/**
 * Wave W8「安全」— 会话安全审计与轻量强制。
 *
 * 覆盖三类与会话相关的安全项：
 * 1. 会话超时（idle）：空闲超过阈值即视为过期（是否强制登出由调用方决定）。
 * 2. 多标签页登出广播：一个标签页登出后，通过 BroadcastChannel 通知其它标签页同步
 *    登出（storage 事件亦可，此处采用 BroadcastChannel；不可用时退化为仅本地）。
 * 3. 离线会话过期：记录离线会话开始时间，超过阈值即过期（防止离线会话无限存活）。
 *
 * 纯函数均可单测；浏览器专属的监听器用守卫保护并返回清理函数。
 */

export interface SessionSecurityConfig {
  /** 空闲超时（毫秒）。 */
  idleTimeoutMs?: number;
  /** 离线会话最长存活（毫秒）。 */
  offlineSessionMaxMs?: number;
  /** 空闲超时触发后的回调（如需强制登出，由调用方决定）。 */
  onIdleTimeout?: () => void;
  /** 收到其它标签页登出广播后的回调。 */
  onRemoteLogout?: () => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟
export const DEFAULT_OFFLINE_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

const OFFLINE_SESSION_KEY = 'ewoh_offline_session_started_at';
export const LOGOUT_CHANNEL_NAME = 'ewoh-session-logout';

// ---- 纯函数：判定 ----

/** 距 lastActivityAt 已超过 idleTimeoutMs 即视为空闲超时。 */
export function isIdleTimeoutExceeded(
  lastActivityAt: number,
  idleTimeoutMs: number,
  now: number = Date.now(),
): boolean {
  return now - lastActivityAt >= idleTimeoutMs;
}

/** 距离线会话开始已超过 offlineSessionMaxMs 即视为离线会话过期。 */
export function isOfflineSessionExpired(
  sessionStartedAt: number,
  offlineSessionMaxMs: number,
  now: number = Date.now(),
): boolean {
  return now - sessionStartedAt >= offlineSessionMaxMs;
}

// ---- 离线会话开始时间 ----

export function storeOfflineSessionStart(
  at: number = Date.now(),
  storage: StorageLike = defaultStorage(),
): void {
  storage.setItem(OFFLINE_SESSION_KEY, String(at));
}

export function getOfflineSessionStart(storage: StorageLike = defaultStorage()): number {
  const raw = storage.getItem(OFFLINE_SESSION_KEY);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function clearOfflineSessionStart(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(OFFLINE_SESSION_KEY);
}

// ---- 空闲活动跟踪器 ----

export interface IdleTracker {
  /** 用户活动时调用，重置空闲计时。 */
  reset(): void;
  stop(): void;
  readonly isIdle: boolean;
}

export function createIdleTracker(
  onIdle: () => void,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): IdleTracker {
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const start = (): void => {
    stop();
    timer = setTimeout(() => {
      if (isIdleTimeoutExceeded(lastActivity, idleTimeoutMs)) {
        onIdle();
      }
    }, idleTimeoutMs);
  };
  start();

  return {
    reset(): void {
      lastActivity = Date.now();
      start();
    },
    stop,
    get isIdle(): boolean {
      return isIdleTimeoutExceeded(lastActivity, idleTimeoutMs);
    },
  };
}

// ---- 多标签页登出广播 ----

type LogoutListener = () => void;
const listeners = new Set<LogoutListener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME);
    channel.onmessage = () => {
      for (const listener of listeners) {
        listener();
      }
    };
  }
  return channel;
}

/** 订阅远程（其它标签页）登出事件，返回取消订阅函数。 */
export function subscribeLogout(listener: LogoutListener): () => void {
  getChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播一次登出（通知其它标签页 + 本地监听者）。 */
export function broadcastLogout(): void {
  const localChannel = getChannel();
  if (localChannel) {
    localChannel.postMessage('logout');
  }
  for (const listener of listeners) {
    listener();
  }
}

/** 关闭登出广播频道并释放其端口，避免测试/卸载后残留开发句柄。 */
export function closeLogoutChannel(): void {
  if (channel) {
    channel.close();
    channel = null;
  }
}

// ---- 初始化：把以上能力绑定到用户活动与登出广播 ----

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;

/**
 * 最小化接线：监听用户活动以重置空闲计时，并订阅远程登出广播。
 * 返回清理函数。非浏览器环境退化为空操作。
 */
export function initSessionSecurity(config: SessionSecurityConfig = {}): () => void {
  if (typeof window === 'undefined') return () => {};

  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const tracker = createIdleTracker(
    () => config.onIdleTimeout?.(),
    idleTimeoutMs,
  );

  const onActivity = (): void => tracker.reset();
  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, onActivity, { passive: true });
  }

  const unsubscribeLogout = subscribeLogout(() => config.onRemoteLogout?.());

  return () => {
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, onActivity);
    }
    unsubscribeLogout();
    tracker.stop();
    closeLogoutChannel();
  };
}

// ---- 存储抽象（便于测试） ----

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike {
  return typeof localStorage !== 'undefined' ? localStorage : memoryStorage();
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}