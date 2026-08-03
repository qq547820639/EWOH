import axios, { type AxiosRequestConfig } from 'axios';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setSession,
} from './auth';
import type { AuthTokens } from '../api/auth';

const baseURL = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_API_BASE_URL || '';

const refreshClient = axios.create({ baseURL, timeout: 15000 });
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
    if (!config.headers) {
      config.headers = new axios.AxiosHeaders();
    }
    (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  return config;
});

async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await refreshClient.post('/api/auth/refresh', { refreshToken });
      const tokens = res.data as AuthTokens;
      setSession(tokens);
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
  window.location.assign(loginPath);
}

http.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    const axiosError = error as {
      response?: { status?: number };
      config?: {
        url?: string;
        headers?: Record<string, string>;
        _retry?: boolean;
      };
    };
    const status = axiosError.response?.status;
    const config = axiosError.config;
    const url = config?.url ?? '';

    if (status !== 401 || !config) {
      return Promise.reject(error);
    }

    const isAuthCall = url.includes('/api/auth/login') || url.includes('/api/auth/refresh');
    if (isAuthCall || config._retry) {
      if (!isAuthCall) redirectToLogin();
      return Promise.reject(error);
    }

    const refreshed = await refreshSession();
    if (!refreshed) {
      redirectToLogin();
      return Promise.reject(error);
    }

    config._retry = true;
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${getAccessToken() ?? ''}`;
    return http.request(config as RetriableRequestConfig);
  },
);

export async function axiosForBackend<T = unknown>(config: {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}): Promise<{ data: any }> {
  return http.request({
    url: config.url,
    method: (config.method ?? 'GET') as never,
    params: config.params,
    data: config.data,
  });
}
