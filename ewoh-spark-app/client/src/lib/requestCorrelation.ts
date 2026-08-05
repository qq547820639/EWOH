/**
 * Wave W8「可观测性」— 请求关联（requestId / traceId）解析。
 *
 * 后端在响应头写入 `x-trace-id`，并在统一错误体 `error.requestId` 中携带
 * requestId（服务端 requestId === traceId，见 tracing.interceptor）。本模块把
 * 这些来源统一解析为可展示的 TraceContext，供错误提示 / 诊断页关联日志。
 */

export interface TraceContext {
  requestId?: string;
  traceId?: string;
}

let lastContext: TraceContext = {};

function firstString(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractFromErrorBody(error: unknown): TraceContext {
  const e = error as { response?: { data?: unknown } };
  const data = e?.response?.data;
  if (typeof data === 'object' && data !== null) {
    const errorObj = (data as { error?: Record<string, unknown> }).error;
    if (typeof errorObj === 'object' && errorObj !== null) {
      return {
        requestId: firstString(errorObj.requestId),
        traceId: firstString(errorObj.traceId),
      };
    }
    return {
      requestId: firstString((data as Record<string, unknown>).requestId),
      traceId: firstString((data as Record<string, unknown>).traceId),
    };
  }
  return {};
}

function extractFromHeaders(error: unknown): TraceContext {
  const e = error as { response?: { headers?: Record<string, unknown> } };
  const headers = e?.response?.headers;
  if (typeof headers === 'object' && headers !== null) {
    const lookup = (key: string): string => {
      const direct = headers[key];
      if (typeof direct === 'string') return direct;
      const lower = headers[key.toLowerCase()];
      return typeof lower === 'string' ? lower : '';
    };
    const traceId = firstString(
      lookup('x-trace-id'),
      lookup('X-Trace-Id'),
      lookup('x-request-id'),
    );
    return { traceId, requestId: firstString(lookup('x-request-id')) };
  }
  return {};
}

const ID_IN_MESSAGE = /(?:request[\s_-]?id|trace[\s_-]?id)[\s:=]+([a-zA-Z0-9._-]+)/i;

function extractFromMessage(error: unknown): TraceContext {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(ID_IN_MESSAGE);
  if (!match) return {};
  return { requestId: match[1], traceId: match[1] };
}

/**
 * 从任意错误对象中解析 requestId / traceId：
 * 优先错误体，其次响应头，最后错误消息文本。
 */
export function extractRequestIds(error: unknown): TraceContext {
  const fromBody = extractFromErrorBody(error);
  const fromHeaders = extractFromHeaders(error);
  const fromMessage = extractFromMessage(error);
  const trace: TraceContext = {};
  const requestId = firstString(
    fromBody.requestId,
    fromHeaders.requestId,
    fromMessage.requestId,
  );
  const traceId = firstString(
    fromBody.traceId,
    fromHeaders.traceId,
    fromMessage.traceId,
  );
  if (requestId) trace.requestId = requestId;
  if (traceId) trace.traceId = traceId;
  return trace;
}

/** 解析错误并缓存为"最近一次请求上下文"，返回该上下文。 */
export function captureTraceContext(error: unknown): TraceContext {
  lastContext = extractRequestIds(error);
  return lastContext;
}

/** 返回最近一次捕获的 TraceContext（用于诊断页/错误提示展示）。 */
export function getTraceContext(): TraceContext {
  return { ...lastContext };
}

/** 便捷：解析错误中的 requestId（无可解析时为空串）。 */
export function extractRequestId(error: unknown): string {
  return extractRequestIds(error).requestId ?? '';
}