import type { ReactNode } from 'react';
import { Inbox, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';

interface QueryStateProps {
  isLoading: boolean;
  isFetching?: boolean;
  isError: boolean;
  isStale?: boolean;
  isEmpty?: boolean;
  onRefresh?: () => void;
  errorMessage?: string;
  emptyMessage?: string;
  loadingMessage?: string;
  updatedAt?: number;
  children: ReactNode;
}

const QueryState = ({
  isLoading,
  isFetching = false,
  isError,
  isStale = false,
  isEmpty = false,
  onRefresh,
  errorMessage = '数据加载失败，请稍后重试。',
  emptyMessage = '暂无数据。',
  loadingMessage = '正在加载数据',
  updatedAt,
  children,
}: QueryStateProps): React.ReactElement => {
  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-6 text-sm text-[hsl(218_10%_42%)]"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="size-4 animate-spin" />
        {loadingMessage}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
        {onRefresh && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRefresh}
            className="self-start border-red-200 bg-white text-red-700 sm:self-auto"
          >
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        )}
      </div>
    );
  }

  const showStatus = isFetching || isStale || Boolean(onRefresh);

  return (
    <>
      {showStatus && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-[hsl(218_10%_42%)]"
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            {isFetching ? (
              <Loader2 className="size-3 animate-spin" />
            ) : isStale ? (
              <TriangleAlert className="size-3 text-amber-500" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {isFetching ? '正在刷新' : isStale ? '数据已过期' : '数据已同步'}
          </span>
          {updatedAt ? (
            <span>
              更新于{' '}
              {new Date(updatedAt).toLocaleTimeString('zh-CN', {
                hour12: false,
              })}
            </span>
          ) : null}
          {onRefresh && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={isFetching}
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <RefreshCw className="size-3" />
              刷新
            </Button>
          )}
        </div>
      )}

      {isEmpty ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-dashed border-[hsl(220_14%_89%)] bg-white p-8 text-sm text-[hsl(218_10%_42%)]"
          role="status"
          aria-live="polite"
        >
          <Inbox className="size-4 shrink-0" />
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </>
  );
};

export default QueryState;
