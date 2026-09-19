export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  /**
   * CLI-501/701（2026-08）：refresh token 经 httpOnly Set-Cookie 下发
   * （ewoh_refresh_token），不再进入登录/刷新响应体。需要续期的用例从这里
   * 取 cookie 值（refreshCookieValue）。apiRequest 恒填充；可选是为了兼容
   * 个别 spec 手工构造的响应字面量。
   */
  setCookie?: string[];
}

export async function apiRequest<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  return { status: response.status, body: body as T, setCookie };
}

export function jsonHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

/**
 * 从 Set-Cookie 值列表中提取 refresh token（server/modules/auth/auth.service.ts
 * 的 REFRESH_TOKEN_COOKIE）。找不到时返回 null（例如登出后的清 cookie 响应）。
 */
export function refreshCookieValue(setCookie: string[] | undefined): string | null {
  for (const entry of setCookie ?? []) {
    const [pair] = entry.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === 'ewoh_refresh_token') {
      const value = pair.slice(eq + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/** CLI-701：refresh 走 cookie 优先（终态契约），此处按 cookie 通道发送。 */
function refreshCookieHeaders(refreshToken: string): Record<string, string> {
  return {
    ...jsonHeaders(),
    cookie: `ewoh_refresh_token=${encodeURIComponent(refreshToken)}`,
  };
}

export interface LoginResponse {
  accessToken: string;
  user: {
    userId: string;
    username: string;
    roles: string[];
    orgId: string;
  };
}

export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<ApiResponse<LoginResponse>> {
  return apiRequest<LoginResponse>(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ username, password }),
  });
}

export async function refresh(
  baseUrl: string,
  refreshToken: string,
): Promise<ApiResponse<LoginResponse>> {
  return apiRequest<LoginResponse>(baseUrl, '/api/auth/refresh', {
    method: 'POST',
    headers: refreshCookieHeaders(refreshToken),
  });
}

export async function logout(
  baseUrl: string,
  refreshToken: string,
): Promise<ApiResponse<{ success: boolean }>> {
  return apiRequest<{ success: boolean }>(baseUrl, '/api/auth/logout', {
    method: 'POST',
    headers: refreshCookieHeaders(refreshToken),
  });
}
