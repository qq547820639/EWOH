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
