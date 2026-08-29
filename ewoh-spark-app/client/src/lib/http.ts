import axios, { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import {
  clearTokens,
  getAccessToken,
  hasSessionTrace,
  setSession,
} from './auth';

const baseURL = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_API_BASE_URL || '';

/**
 * SSE/流式请求与 axios 实例共用同一 API base。
 * CLI-723：ai.ts 的 SSE fetch 此前用相对路径，跨域 API 网关部署
 * （VITE_API_BASE_URL 非空）下会打到错误 origin 造成死链；统一由此构造。
 */
export function apiBaseUrl(): string {
  return baseURL;
}

// CLI-701：刷新凭证在 httpOnly cookie；withCredentials 保证跨域 API
// 网关部署下浏览器也会附带 cookie（同源部署时默认即附带）。
const refreshClient = axios.create({
  baseURL,
  timeout: 15000,
  withCredentials: true,
});
let refreshPromise: Promise<boolean> | null = null;

interface RetriableRequestConfig extends AxiosRequestConfig {
  _retry?: boolean;
}

export const http = axios.create({
  baseURL,
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    // CLI-717：用 AxiosHeaders 构造/赋值，消除 `as Record<string,string>`
    // 类型断言（错误断言会绕过 AxiosHeaders 的规范化与类型约束）。
    const headers = AxiosHeaders.from(config.headers);
    headers.set('Authorization', `Bearer ${token}`);
    config.headers = headers;
  }
  return config;
});

async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    // CLI-706：无任何会话痕迹时不发刷新请求——refresh cookie 必然不存在，
    // 发请求只会得到 401 并造成无意义的循环与日志噪声。
    if (!hasSessionTrace()) return false;
    try {
      // CLI-701：refresh token 由服务端从 httpOnly cookie 读取（轮转后
      // 重新 Set-Cookie），请求体不携带任何凭证。
      const res = await refreshClient.post('/api/auth/refresh');
      const tokens = res.data as Parameters<typeof setSession>[0];
      setSession(tokens);
      // CLI-706：刷新成功但 access token 为空（畸形响应）视为失败，
      // 不允许带着空 Bearer 头重放请求陷入 401 死循环。
      if (!getAccessToken()) {
        clearTokens();
        return false;
      }
      return true;
    } catch {
      clearTokens();
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path.endsWith('/login')) return;
  const base = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.BASE_URL || '/';
  const loginPath = `${base.replace(/\/+$/, '')}/login`;
  // CLI-507：携带 return 参数记录被中断的完整路径（含查询串），登录页
  // 成功后可恢复到原页面，而不是丢失上下文跳默认首页。
  const current = `${window.location.pathname}${window.location.search}`;
  const target = current && current !== '/' ? `${loginPath}?redirect=${encodeURIComponent(current)}` : loginPath;
  window.location.assign(target);
}

/**
 * CLI-705：认证端点枚举精确匹配（去掉查询串后比对全路径）。
 * 字符串 includes 会把 `/api/auth/login-callback` 等误判为登录调用，
 * 导致其 401 被静默吞掉而非触发刷新/跳转。
 */
const AUTH_ENDPOINTS = new Set([
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

function isAuthEndpoint(url: string): boolean {
  const pathname = url.split('?')[0];
  return AUTH_ENDPOINTS.has(pathname);
}

http.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    const axiosError = error as {
      response?: { status?: number };
      config?: RetriableRequestConfig & { headers?: unknown };
    };
    const status = axiosError.response?.status;
    const config = axiosError.config;
    const url = config?.url ?? '';

    if (status !== 401 || !config) {
      return Promise.reject(error);
    }

    if (isAuthEndpoint(url) || config._retry) {
      if (!isAuthEndpoint(url)) redirectToLogin();
      return Promise.reject(error);
    }

    const refreshed = await refreshSession();
    if (!refreshed) {
      redirectToLogin();
      return Promise.reject(error);
    }

    // CLI-706：重放前必须有非空 token；为空直接 reject，避免空 Bearer
    // 触发又一轮 401→refresh 循环。
    const token = getAccessToken();
    if (!token) {
      clearTokens();
      redirectToLogin();
      return Promise.reject(error);
    }

    config._retry = true;
    const headers = AxiosHeaders.from(config.headers);
    headers.set('Authorization', `Bearer ${token}`);
    config.headers = headers;
    return http.request(config);
  },
);

/**
 * CLI-508 / CLI-718 / CLI-722：泛型 T 真正生效——原签名声明 <T> 却固定
 * 返回 { data: any }，调用方（如 files.ts）传入的类型参数被静默忽略。
 * 现按 T 返回 data；默认 any 保持存量未标注调用点的既有行为（25+ 个
 * api/ 文件逐步标注类型时可获得真实检查）。
 */
export async function axiosForBackend<T = any>(config: {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeout?: number;
}): Promise<{ data: T }> {
  const res = await http.request<T>({
    url: config.url,
    method: (config.method ?? 'GET') as never,
    params: config.params,
    data: config.data,
    signal: config.signal,
    headers: config.headers,
    timeout: config.timeout,
  });
  return { data: res.data };
}
