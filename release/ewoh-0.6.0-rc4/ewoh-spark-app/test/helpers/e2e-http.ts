export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
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
  return { status: response.status, body: body as T };
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

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
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
    headers: jsonHeaders(),
    body: JSON.stringify({ refreshToken }),
  });
}

export async function logout(
  baseUrl: string,
  refreshToken: string,
): Promise<ApiResponse<{ success: boolean }>> {
  return apiRequest<{ success: boolean }>(baseUrl, '/api/auth/logout', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ refreshToken }),
  });
}
