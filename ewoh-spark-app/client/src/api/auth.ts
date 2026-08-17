import { axiosForBackend } from '../lib/http';

export interface AuthUser {
  userId: string;
  username: string;
  roles: string[];
  orgId: string;
}

/**
 * CLI-501/701：refresh token 不再随响应体下发——服务端经
 * httpOnly cookie 下发与轮转（JS 不可读）。字段保留为可选以兼容
 * 过渡期旧响应描述，客户端不再持久化任何 refresh 凭证。
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  user: AuthUser;
}

export async function login(username: string, password: string): Promise<AuthTokens> {
  const res = await axiosForBackend({
    url: '/api/auth/login',
    method: 'POST',
    data: { username, password },
  });
  return res.data as AuthTokens;
}

/**
 * CLI-701：刷新凭证在 httpOnly cookie 中，请求不携带 token body；
 * cookie 由浏览器随同源请求自动附带（跨域部署时 withCredentials 生效）。
 */
export async function refresh(): Promise<AuthTokens> {
  const res = await axiosForBackend({
    url: '/api/auth/refresh',
    method: 'POST',
    data: {},
  });
  return res.data as AuthTokens;
}

/** CLI-501：登出吊销由服务端从 httpOnly cookie 读取 refresh token 完成。 */
export async function logout(): Promise<void> {
  await axiosForBackend({
    url: '/api/auth/logout',
    method: 'POST',
    data: {},
  });
}
