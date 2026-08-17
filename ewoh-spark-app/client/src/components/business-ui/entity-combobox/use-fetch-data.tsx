'use client';

import { logger } from '@lark-apaas/client-toolkit/logger';
import { useCallback, useEffect, useRef, useState } from 'react';

export type UseFetchDataOptions<T> = {
  fetchFn: (search: string) => Promise<{ items: T[] }>;
  enabled: boolean;
  search: string;
  onSearch?: (search: string) => void;
};

export type UseFetchDataResult<T> = {
  data: T[] | undefined;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  fetchStatus: 'fetching' | 'idle';
  refetch: () => Promise<void>;
};

export function useFetchData<T>({
  fetchFn,
  enabled,
  search,
  onSearch,
}: UseFetchDataOptions<T>): UseFetchDataResult<T> {
  const [data, setData] = useState<T[] | undefined>();
  const [isFetching, setIsFetching] = useState(false);
  const [isError, setIsError] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  // CLI-314：请求序号守卫——连续搜索时只接受最新一次请求的结果，避免旧
  // 响应晚到覆盖新响应（fetchFn 契约不支持 AbortSignal，用序号等效防竞态）。
  const latestRequestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!enabled || search.trim() === '') {
      setData([]);
      setIsSuccess(true);
      return;
    }

    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;

    try {
      setIsFetching(true);
      setIsError(false);

      const result = await fetchFn(search);

      if (latestRequestIdRef.current !== requestId) return; // 已被更新的搜索取代
      setData(result?.items || []);
      setIsSuccess(true);
      setIsError(false);
    } catch (error) {
      if (latestRequestIdRef.current !== requestId) return;
      logger.error('Failed to fetch data:', error);
      setIsError(true);
      setIsSuccess(false);
      setData([]);
    } finally {
      if (latestRequestIdRef.current === requestId) {
        setIsFetching(false);
      }
    }
  }, [enabled, search, fetchFn]);

  useEffect(() => {
    if (enabled && search.trim() !== '') {
      fetchData();
    } else {
      setData(undefined);
      setIsSuccess(true);
    }
  }, [search, enabled, fetchData]);

  // 单独处理 onSearch 回调
  useEffect(() => {
    onSearch?.(search);
  }, [search, onSearch]);

  return {
    data,
    isFetching,
    isError,
    isSuccess,
    fetchStatus: isFetching ? 'fetching' : 'idle',
    refetch: fetchData,
  };
}
