/**
 * CLI-501/701 新契约测试：access token 内存+sessionStorage，
 * refresh token 不落任何 Web Storage（httpOnly cookie 由服务端管理）。
 */

// 截断 auth → api/auth → lib/http（axios + import.meta）依赖链，单测只验存储契约。
jest.mock('../api/auth', () => ({
  logout: jest.fn().mockResolvedValue(undefined),
}));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

function installWindowMock() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage,
    sessionStorage,
  };
  return { localStorage, sessionStorage };
}

function loadAuthModule() {
  let mod: typeof import('./auth');
  jest.isolateModules(() => {
    mod = require('./auth');
  });
  return mod!;
}

const USER = {
  userId: 'u1',
  username: 'op',
  roles: ['operator'],
  orgId: 'org-1',
};

describe('auth token storage（CLI-501/701 契约）', () => {
  beforeEach(() => {
    jest.resetModules();
    installWindowMock();
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('setSession persists access token + user in sessionStorage only, never localStorage', () => {
    const auth = loadAuthModule();
    const { localStorage, sessionStorage } = (
      globalThis as unknown as { window: { localStorage: MemoryStorage; sessionStorage: MemoryStorage } }
    ).window;

    auth.setSession({ accessToken: 'at-1', user: USER });

    expect(auth.getAccessToken()).toBe('at-1');
    expect(sessionStorage.getItem('ewoh_access_token')).toBe('at-1');
    expect(sessionStorage.getItem('ewoh_auth_user')).toContain('"op"');
    // 核心断言：任何凭证不进 localStorage（XSS 长期窃取面消除）。
    expect(localStorage.getItem('ewoh_access_token')).toBeNull();
    expect(localStorage.getItem('ewoh_refresh_token')).toBeNull();
    expect(localStorage.getItem('ewoh_auth_user')).toBeNull();
  });

  it('clearTokens wipes session state and hasSessionTrace goes false', () => {
    const auth = loadAuthModule();
    auth.setSession({ accessToken: 'at-1', user: USER });
    expect(auth.hasSessionTrace()).toBe(true);
    expect(auth.isAuthenticated()).toBe(true);

    auth.clearTokens();
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getAuthUser()).toBeNull();
    expect(auth.hasSessionTrace()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('legacy localStorage tokens are migrated/cleared on module load (refresh token dropped)', () => {
    const { window } = globalThis as unknown as {
      window: { localStorage: MemoryStorage; sessionStorage: MemoryStorage };
    };
    // 模拟旧版本遗留：localStorage 中三件套齐全。
    window.localStorage.setItem('ewoh_access_token', 'legacy-at');
    window.localStorage.setItem('ewoh_refresh_token', 'legacy-rt');
    window.localStorage.setItem('ewoh_auth_user', JSON.stringify(USER));

    const auth = loadAuthModule();

    // access/身份迁入 sessionStorage 保留登录态。
    expect(window.sessionStorage.getItem('ewoh_access_token')).toBe('legacy-at');
    expect(auth.getAccessToken()).toBe('legacy-at');
    // refresh token 被丢弃，localStorage 全部清空。
    expect(window.localStorage.getItem('ewoh_refresh_token')).toBeNull();
    expect(window.localStorage.getItem('ewoh_access_token')).toBeNull();
    expect(window.localStorage.getItem('ewoh_auth_user')).toBeNull();
  });

  it('decodeJwtPayload decodes payload for UI display only (CLI-506/702 裁决)', () => {
    const auth = loadAuthModule();
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u1', username: 'op', roles: ['operator'], orgId: 'o' }),
    ).toString('base64url');
    expect(auth.decodeJwtPayload(`h.${payload}.s`)).toEqual({
      sub: 'u1',
      username: 'op',
      roles: ['operator'],
      orgId: 'o',
    });
    expect(auth.decodeJwtPayload('not-a-jwt')).toBeNull();
  });
});
