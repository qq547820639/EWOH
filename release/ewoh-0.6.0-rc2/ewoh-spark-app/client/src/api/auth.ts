import { axiosForBackend } from '../lib/http';

export interface AuthUser {
  userId: string;
  username: string;
  roles: string[];
  orgId: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
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

export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const res = await axiosForBackend({
    url: '/api/auth/refresh',
    method: 'POST',
    data: { refreshToken },
  });
  return res.data as AuthTokens;
}

export async function logout(refreshToken: string): Promise<void> {
  await axiosForBackend({
    url: '/api/auth/logout',
    method: 'POST',
    data: { refreshToken },
  });
}
