import type { AuthTokens, AuthUser } from '../api/auth';
import { logout as revokeServerRefreshToken } from '../api/auth';
import { broadcastLogout } from './sessionSecurity';
import { sessionLifecycle } from './runtimeLifecycle';

const ACCESS_KEY = 'ewoh_access_token';
const REFRESH_KEY = 'ewoh_refresh_token';
const AUTH_USER_KEY = 'ewoh_auth_user';

export interface DecodedAuthPayload {
  sub?: string;
  username?: string;
  roles?: string[];
  orgId?: string;
}

export function decodeJwtPayload(token: string): DecodedAuthPayload | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = atob(padded);
    const parsed = JSON.parse(json) as DecodedAuthPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function setAuthUser(user: AuthUser): void {
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

export function setSession(tokens: AuthTokens): void {
  setTokens(tokens.accessToken, tokens.refreshToken);
  setAuthUser(tokens.user);
}

export function getAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AuthUser;
      if (parsed && Array.isArray(parsed.roles) && parsed.username) {
        return parsed;
      }
    }
  } catch {
    // Fall through to token-derived identity.
  }

  const token = getAccessToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload?.roles) return null;
  return {
    userId: payload.sub ?? payload.username ?? '',
    username: payload.username ?? '用户',
    roles: payload.roles,
    orgId: payload.orgId ?? '',
  };
}

export function getCurrentOperator(): string {
  return getAuthUser()?.username ?? 'anonymous';
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export async function revokeSession(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    try {
      await revokeServerRefreshToken(refreshToken);
    } catch {
      // Local logout still proceeds when the server session is already invalid.
    }
  }
  clearTokens();
  // 统一释放旧会话资源（WebSocket/SSE/定时器/重试/广播等），避免旧会话继续接收消息或写入数据。
  sessionLifecycle.disposeForReason('logout');
  // 通知其它标签页同步登出（BroadcastChannel；见 ux009-uxindustrial 多标签登出测试）。
  broadcastLogout();
}

export function isAuthenticated(): boolean {
  return Boolean(getAccessToken());
}
