import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export function withRequestContext<T>(
  data: RequestContextData,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(data, operation);
}

export function currentRequestContext(): RequestContextData | undefined {
  return storage.getStore();
}

/**
 * NO-10a（ADR-022）：当前 HTTP traceId = §19 全链路 correlation id。
 * 非 HTTP 路径显式返回 null（绝不伪造新 ID——伪造会制造无法溯源的关联）。
 */
export function currentTraceId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
