import type { ReactNode } from 'react';
import { CheckCircle2, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import ErrorState from '@client/src/components/ErrorState';

interface QueryStateProps {
  isLoading: boolean;
  isFetching?: boolean;
  isError: boolean;
  isStale?: boolean;
  isEmpty?: boolean;
  onRefresh?: () => void;
  errorMessage?: string;
  error?: unknown;
  onBack?: () => void;
  onSaveDraft?: () => void;
  backHref?: string;
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
  error,
  onBack,
  onSaveDraft,
  backHref,
  emptyMessage = '暂无数据。',
  loadingMessage = '正在加载数据',
  updatedAt,
  children,
}: QueryStateProps): React.ReactElement => {
  if (isLoading) {
    return (
      <div
        /* R2-CC2-002：加载态表面 bg-card→bg-card 令牌（dark 主题下可读）。 */
        className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground"
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
      <ErrorState
        error={error}
        errorMessage={errorMessage}
        onRetry={onRefresh}
        onBack={onBack}
        onSaveDraft={onSaveDraft}
        backHref={backHref}
      />
    );
  }

  const showStatus = isFetching || isStale || Boolean(onRefresh);

  return (
    <>
      {showStatus && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            {isFetching ? (
              <Loader2 className="size-3 animate-spin" />
            ) : isStale ? (
              <RefreshCw className="size-3 text-muted-foreground" />
            ) : (
              <CheckCircle2 className="size-3 text-muted-foreground" />
            )}
            {/* 文案优化（2026-08-19）：原“数据已同步/数据已过期”语义误导——
             * 实为 react-query 缓存新鲜度（staleTime 窗口），非业务同步状态；
             * 改为中性的“已是最新/待更新”，过期态不再用三角警告图标。 */}
            {isFetching ? '刷新中…' : isStale ? '数据待更新' : '数据已是最新'}
          </span>
          {updatedAt ? (
            <span>
              更新于{' '}
              {/* CLI-328：全站展示统一 Asia/Shanghai 时区。 */}
              {new Date(updatedAt).toLocaleTimeString('zh-CN', {
                hour12: false,
                timeZone: 'Asia/Shanghai',
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
          /* R2-CC2-002：空态表面 bg-card→bg-card 令牌（dark 主题下可读）。 */
          className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-card p-8 text-sm text-muted-foreground"
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
