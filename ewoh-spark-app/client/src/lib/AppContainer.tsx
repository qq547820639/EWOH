import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

export const AppContainer = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(createAppQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};
