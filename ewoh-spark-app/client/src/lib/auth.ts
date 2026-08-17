import type { AuthTokens, AuthUser } from '../api/auth';
import { logout as revokeServerRefreshToken } from '../api/auth';
import { broadcastLogout } from './sessionSecurity';
import { sessionLifecycle } from './runtimeLifecycle';

/**
 * CLI-501/701：token 存储收敛。
 * - refresh token：httpOnly cookie（服务端下发/轮转/吊销），JS 完全不可读，
 *   不再落任何 Web Storage——XSS 无法窃取 30 天长期凭证。
 * - access token：内存 + sessionStorage（标签页生命周期，刷新页面可恢复，
 *   关闭即清；8h 短期凭证，窃取窗口与可利用性远低于 localStorage 持久化）。
 * - auth user（仅 UI 展示）：随 access token 存 sessionStorage。
 */

const ACCESS_KEY = 'ewoh_access_token';
const REFRESH_KEY = 'ewoh_refresh_token';
const AUTH_USER_KEY = 'ewoh_auth_user';

export interface DecodedAuthPayload {
  sub?: string;
  username?: string;
  roles?: string[];
  orgId?: string;
}

/**
 * CLI-506/702 裁决：客户端 JWT 解码不验签（浏览器无安全保存私钥的验签
 * 途径），decodeJwtPayload 仅用于 UI 展示与路由体验优化——角色/组织等
 * 授权判定一律以服务端校验为准（AccessTokenGuard 验签 + RBAC），过期由
 * 后端 401 兜底。篡改本地 token 只能骗过当前用户自己的 UI，无法越权。
 */
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

/** 内存副本：减少 sessionStorage 读取；页面刷新后由 restore() 恢复。 */
let accessTokenInMemory: string | null = null;
let authUserInMemory: AuthUser | null = null;

function sessionStorageSafe(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function localStorageSafe(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 一次性迁移（CLI-501）：清除 localStorage 中的历史凭证——refresh token
 * 直接丢弃（服务端按 TTL 自然过期，泄漏面立即消除）；access/身份迁入
 * sessionStorage 保留当前登录态，避免升级即全员强制重登。
 */
(function migrateLegacyLocalStorage() {
  const local = localStorageSafe();
  if (!local) return;
  try {
    const session = sessionStorageSafe();
    if (session) {
      if (!session.getItem(ACCESS_KEY)) {
        const legacyAccess = local.getItem(ACCESS_KEY);
        if (legacyAccess) session.setItem(ACCESS_KEY, legacyAccess);
        const legacyUser = local.getItem(AUTH_USER_KEY);
        if (legacyUser) session.setItem(AUTH_USER_KEY, legacyUser);
      }
    }
    local.removeItem(REFRESH_KEY);
    local.removeItem(ACCESS_KEY);
    local.removeItem(AUTH_USER_KEY);
  } catch {
    // Storage 被禁用等场景下静默跳过（token 本就不持久化）。
  }
})();

function restoreFromSession(): void {
  if (accessTokenInMemory !== null) return;
  const session = sessionStorageSafe();
  if (!session) return;
  try {
    accessTokenInMemory = session.getItem(ACCESS_KEY);
  } catch {
    accessTokenInMemory = null;
  }
}

export function setTokens(accessToken: string): void {
  accessTokenInMemory = accessToken;
  const session = sessionStorageSafe();
  try {
    session?.setItem(ACCESS_KEY, accessToken);
  } catch {
    // 内存副本仍可用；仅失去页面刷新后的恢复能力。
  }
}

export function setAuthUser(user: AuthUser): void {
  authUserInMemory = user;
  const session = sessionStorageSafe();
  try {
    session?.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch {
    // 同上：内存副本优先。
  }
}

export function setSession(tokens: AuthTokens): void {
  setTokens(tokens.accessToken);
  setAuthUser(tokens.user);
}

export function getAuthUser(): AuthUser | null {
  if (authUserInMemory) return authUserInMemory;
  const session = sessionStorageSafe();
  try {
    const raw = session?.getItem(AUTH_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AuthUser;
      if (parsed && Array.isArray(parsed.roles) && parsed.username) {
        authUserInMemory = parsed;
        return parsed;
      }
    }
  } catch {
    // Fall through to token-derived identity.
  }

  const token = getAccessToken();
  if (!token) return null;
  // CLI-732（裁决）：sessionStorage 身份缺失时从 JWT 解码恢复展示身份。
  // 该 roles 仅驱动 UI 导航/展示；一切授权判定在服务端（AccessTokenGuard
  // 验签 + RBAC），篡改本地 token 无法越权，维持现状。
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
  restoreFromSession();
  return accessTokenInMemory;
}

/**
 * CLI-706：是否存在「曾登录」的会话痕迹（access token 或身份缓存）。
 * 无痕迹时不发起刷新请求（cookie 也必然不存在），避免 401→refresh 死循环。
 */
export function hasSessionTrace(): boolean {
  return getAccessToken() !== null || getAuthUser() !== null;
}

export function clearTokens(): void {
  accessTokenInMemory = null;
  authUserInMemory = null;
  const session = sessionStorageSafe();
  try {
    session?.removeItem(ACCESS_KEY);
    session?.removeItem(AUTH_USER_KEY);
  } catch {
    // 忽略：无持久化可清。
  }
}

export async function revokeSession(): Promise<void> {
  // CLI-501：refresh token 在 httpOnly cookie 中，吊销由服务端读取完成；
  // 本地失败（cookie 已失效/网络异常）不阻塞登出。
  try {
    await revokeServerRefreshToken();
  } catch {
    // Local logout still proceeds when the server session is already invalid.
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
