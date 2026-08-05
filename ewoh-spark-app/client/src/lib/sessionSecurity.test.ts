import {
  broadcastLogout,
  clearOfflineSessionStart,
  closeLogoutChannel,
  createIdleTracker,
  getOfflineSessionStart,
  initSessionSecurity,
  isIdleTimeoutExceeded,
  isOfflineSessionExpired,
  storeOfflineSessionStart,
  subscribeLogout,
} from './sessionSecurity';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('sessionSecurity', () => {
  it('judges idle timeout against last activity', () => {
    const now = 1_000_000;
    expect(isIdleTimeoutExceeded(now - 1000, 5000, now)).toBe(false);
    expect(isIdleTimeoutExceeded(now - 6000, 5000, now)).toBe(true);
  });

  it('judges offline session expiry against session start', () => {
    const now = 1_000_000;
    expect(isOfflineSessionExpired(now - 1000, 5000, now)).toBe(false);
    expect(isOfflineSessionExpired(now - 6000, 5000, now)).toBe(true);
  });

  it('stores and reads the offline session start time', () => {
    const storage = memoryStorage();
    storeOfflineSessionStart(12345, storage as never);
    expect(getOfflineSessionStart(storage as never)).toBe(12345);
    clearOfflineSessionStart(storage as never);
    expect(getOfflineSessionStart(storage as never)).toBe(0);
  });

  it('idle tracker exposes reset/stop/isIdle and reflects idleness', () => {
    const onIdle = jest.fn();
    const tracker = createIdleTracker(onIdle, 1000);
    expect(typeof tracker.reset).toBe('function');
    expect(typeof tracker.stop).toBe('function');
    expect(typeof tracker.isIdle).toBe('boolean');
    // 断言 onIdle 未凭空触发；isIdle 与纯函数判定一致。
    expect(onIdle).not.toHaveBeenCalled();
    expect(tracker.isIdle).toBe(
      isIdleTimeoutExceeded(Date.now() - 0, 1000),
    );
    tracker.stop();
  });

  it('broadcastLogout notifies local subscribers', () => {
    const handler = jest.fn();
    const unsubscribe = subscribeLogout(handler);
    broadcastLogout();
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    broadcastLogout();
    expect(handler).toHaveBeenCalledTimes(1);
    closeLogoutChannel();
  });

  it('initSessionSecurity is a no-op outside a browser', () => {
    const cleanup = initSessionSecurity();
    expect(typeof cleanup).toBe('function');
    cleanup();
  });
});