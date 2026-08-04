// 统一错误契约解析工具
// 后端统一错误响应：{ error: { code, errorCode, message, details, requestId, retryable, recommendedAction, ... } }
// 本模块负责从 axios 错误对象（或任意错误）中解析出展示所需的字段，并归类为四类差异化错误。

export type ErrorKind =
  | 'permission'
  | 'validation'
  | 'connection'
  | 'server'
  | 'unknown';

export interface ParsedError {
  /** 错误码（优先 errorCode，其次 code，最后按 HTTP status 推断） */
  code: string;
  /** 请求 ID，用于日志/审计/Support Bundle 关联 */
  requestId: string;
  /** 中文推荐动作 */
  recommendedAction: string;
  /** 用户可理解的错误信息 */
  message: string;
  /** 差异化错误类别 */
  kind: ErrorKind;
}

const KIND_DEFAULT: Record<
  ErrorKind,
  { message: string; recommendedAction: string }
> = {
  permission: {
    message: '您没有权限执行此操作',
    recommendedAction: '请联系管理员开通权限后重试',
  },
  validation: {
    message: '操作未通过校验，请检查后重试',
    recommendedAction: '请检查填写内容后重试',
  },
  connection: {
    message: '网络连接失败，请检查网络后重试',
    recommendedAction: '请检查网络连接后重试',
  },
  server: {
    message: '服务器暂时不可用，请稍后重试',
    recommendedAction: '请稍后重试；如持续失败请联系管理员',
  },
  unknown: {
    message: '操作失败，请稍后重试',
    recommendedAction: '请稍后重试',
  },
};

function getStatus(error: unknown): number | undefined {
  const e = error as { response?: { status?: unknown } } | null;
  const status = e?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function getErrorObject(error: unknown): Record<string, unknown> | undefined {
  const e = error as { response?: { data?: unknown } } | null;
  const data = e?.response?.data;
  if (typeof data === 'object' && data !== null) {
    const errorObj = (data as { error?: unknown }).error;
    if (typeof errorObj === 'object' && errorObj !== null) {
      return errorObj as Record<string, unknown>;
    }
  }
  return undefined;
}

function isConnectionError(error: unknown): boolean {
  const e = error as { code?: unknown; response?: unknown; message?: unknown } | null;
  // 有响应说明非连接层错误
  if (e?.response) return false;
  const code = typeof e?.code === 'string' ? e.code.toUpperCase() : '';
  if (
    /^(ECONNABORTED|ERR_NETWORK|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|NETWORK_ERROR|ENOTFOUND)$/.test(
      code,
    )
  ) {
    return true;
  }
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('网络') ||
    msg.includes('超时') ||
    msg.includes('offline')
  );
}

function httpStatusToCode(status: number): string {
  if (status === 401 || status === 403) return 'PERMISSION_DENIED';
  if (status === 400 || status === 422) return 'BUSINESS_VALIDATION';
  if (status >= 500) return 'SERVER_ERROR';
  return `HTTP_${status}`;
}

function inferKind(
  status: number | undefined,
  connection: boolean,
  code: string,
): ErrorKind {
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'permission';
    if (status === 400 || status === 422) return 'validation';
    if (status >= 500) return 'server';
  }
  if (connection) return 'connection';
  const upper = code.toUpperCase();
  if (/PERMISSION|FORBIDDEN|UNAUTHORIZED|ACCESS_DENIED/.test(upper)) return 'permission';
  if (/VALIDATION|INVALID_ARGUMENT|BUSINESS/.test(upper)) return 'validation';
  if (/INTERNAL|SERVER_ERROR|UNAVAILABLE|TIMEOUT|GATEWAY|TOO_MANY/.test(upper)) {
    return 'server';
  }
  return 'unknown';
}

function getRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function parseError(error: unknown): ParsedError {
  const status = getStatus(error);
  const errorObj = getErrorObject(error);
  const connection = isConnectionError(error);

  const rawCode =
    typeof errorObj?.errorCode === 'string' && errorObj.errorCode
      ? errorObj.errorCode
      : typeof errorObj?.code === 'string' && errorObj.code
        ? errorObj.code
        : status !== undefined
          ? httpStatusToCode(status)
          : connection
            ? 'CONNECTION_ERROR'
            : 'UNKNOWN_ERROR';

  const kind = inferKind(status, connection, rawCode);
  const fallback = KIND_DEFAULT[kind];

  const requestId =
    typeof errorObj?.requestId === 'string' ? errorObj.requestId : '';
  const recommendedAction =
    typeof errorObj?.recommendedAction === 'string' && errorObj.recommendedAction
      ? errorObj.recommendedAction
      : fallback.recommendedAction;
  const message =
    typeof errorObj?.message === 'string' && errorObj.message
      ? errorObj.message
      : getRawMessage(error) || fallback.message;

  return { code: rawCode, requestId, recommendedAction, message, kind };
}