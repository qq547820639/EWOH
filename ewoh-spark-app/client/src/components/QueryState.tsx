import type { ReactNode } from 'react';
import { CheckCircle2, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import ErrorState from '@client/src/components/ErrorState';

/**
 * react-query 结果的最小结构面（`UseQueryResult` 结构兼容）。
 *
 * 为什么做成"可直传"：本组件早已实现"错误优先于空态"，但 2026-09 审计发现
 * 多个页面**根本没传 `isError`**——查询拿到 403/500 后 `rows.length === 0` 成立，
 * 于是页面把"没有权限"渲染成「暂无外骨骼设备」「当前没有待批审批」之类的**业务空态**。
 * 这是把"读不到"伪造成"不存在"，直接违反原则 7（缺失/不可信数据不得被静默伪造成确定事实）。
 * 传 `query` 后这些标志由组件自己派生，页面不再有机会漏掉分支。
 */
export interface QueryLike {
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  error?: unknown;
  isStale?: boolean;
  dataUpdatedAt?: number;
}

interface QueryStateProps {
  /**
   * react-query 结果对象（**推荐用法**）。传入后 loading / error / stale / updatedAt
   * 由它派生；显式传入的同名 props 优先级更高（便于页面覆盖特例）。
   */
  query?: QueryLike;
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
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
  query,
  isLoading,
  isFetching,
  isError,
  isStale,
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
  // 显式 prop 优先，其次取 query，最后按"未知即未加载完/无错误"兜底。
  // 注意：这里不能用参数默认值（默认值会把 undefined 变成具体值，遮蔽 query 派生）。
  const loading = isLoading ?? query?.isLoading ?? false;
  const fetching = isFetching ?? query?.isFetching ?? false;
  const errored = isError ?? query?.isError ?? false;
  const stale = isStale ?? query?.isStale ?? false;
  const resolvedError = error ?? query?.error;
  const resolvedUpdatedAt = updatedAt ?? query?.dataUpdatedAt;

  if (loading) {
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

  if (errored) {
    return (
      <ErrorState
        error={resolvedError}
        errorMessage={errorMessage}
        onRetry={onRefresh}
        onBack={onBack}
        onSaveDraft={onSaveDraft}
        backHref={backHref}
      />
    );
  }

  const showStatus = fetching || stale || Boolean(onRefresh);

  return (
    <>
      {showStatus && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            {fetching ? (
              <Loader2 className="size-3 animate-spin" />
            ) : stale ? (
              <RefreshCw className="size-3 text-muted-foreground" />
            ) : (
              <CheckCircle2 className="size-3 text-muted-foreground" />
            )}
            {/* 文案优化（2026-08-19）：原“数据已同步/数据已过期”语义误导——
             * 实为 react-query 缓存新鲜度（staleTime 窗口），非业务同步状态；
             * 改为中性的“已是最新/待更新”，过期态不再用三角警告图标。 */}
            {fetching ? '刷新中…' : stale ? '数据待更新' : '数据已是最新'}
          </span>
          {resolvedUpdatedAt ? (
            <span>
              更新于{' '}
              {/* CLI-328：全站展示统一 Asia/Shanghai 时区。 */}
              {new Date(resolvedUpdatedAt).toLocaleTimeString('zh-CN', {
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
              disabled={fetching}
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
