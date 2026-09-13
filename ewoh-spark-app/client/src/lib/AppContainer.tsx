import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { onAuthChange } from './auth';

/**
 * CLI-537：QueryClient 工厂——AppContainer 每个 App 实例创建独立 client，
 * 替代模块级单例（多应用/测试并行渲染时共享缓存会造成跨实例数据污染）。
 * gcTime 由默认 5 分钟收紧到 60 秒，降低卸载查询的缓存驻留。
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 10_000,
        gcTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Stop old requests before dropping every cached tenant/user result. */
export async function clearQueryClientForAuthChange(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
}

export const AppContainer = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(createAppQueryClient);
  useEffect(() => onAuthChange((change) => {
    if (change.reason === 'logout' || change.previous?.userId !== change.current?.userId ||
        change.previous?.orgId !== change.current?.orgId) {
      void clearQueryClientForAuthChange(queryClient);
    }
  }), [queryClient]);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};
