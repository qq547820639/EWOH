/* DecisionHistoryConsole.tsx — 决策历史控制台（NO-13q / ADR-066，§17/§18）。
 *
 * Decision History 统一读面消费端：kind/status 过滤 + 分页（limit 50
 * "加载更多"）+ skippedInvalid 显式横幅（§33）+ 错误/空/加载态。
 * 服务端排序为权威（客户端零聚合/排序）；展示层不做二次解释。
 */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History, Loader2, TriangleAlert, RefreshCw } from 'lucide-react';
import { fetchDecisionHistory } from '../../api/decisions';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import {
  buildDecisionRows,
  buildSourcesSummary,
  DECISION_KIND_LABELS,
  DECISION_STATUS_LABELS,
} from './decisionHistoryLogic';
import { DecisionHistoryTable } from './DecisionHistoryTable';

const PAGE_SIZE = 50;

const KIND_OPTIONS = Object.entries(DECISION_KIND_LABELS);
const STATUS_OPTIONS = Object.entries(DECISION_STATUS_LABELS);

export default function DecisionHistoryConsole(): React.ReactElement {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');

  // CLI-103：useInfiniteQuery 分页累加（原 useQuery offset 变更后仅含当前页，
  // 前页丢失且「已显示 X/Y」文案误导）。
  const query = useInfiniteQuery({
    queryKey: [queryKeys.decisions, kind, status],
    queryFn: ({ pageParam }) =>
      fetchDecisionHistory({
        kind: kind || undefined,
        status: status || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const rows = buildDecisionRows(items);
  const lastPage = query.data?.pages[query.data.pages.length - 1] ?? null;
  const total = lastPage?.total ?? 0;
  const skippedInvalid =
    query.data?.pages.reduce((n, p) => n + (p.skippedInvalid ?? 0), 0) ?? 0;
  const sourcesSummary = lastPage
    ? buildSourcesSummary(lastPage.sources)
    : '';

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <History className="size-5 text-foreground" />
        <h1 className="text-lg font-semibold text-foreground">决策历史</h1>
        <span className="text-xs text-muted-foreground">
          Decision Catalog 8 类 kind 统一读面（ADR-065）
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-foreground">
          类型
          <select
            data-testid="decision-history-kind-filter"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
            }}
            className="rounded border border-border px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-foreground">
          状态
          <select
            data-testid="decision-history-status-filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
            className="rounded border border-border px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {query.isError && (
          <span
            data-testid="decision-history-error"
            className="flex items-center gap-1.5 text-sm text-red-600"
          >
            <TriangleAlert className="size-4" />
            决策历史加载失败
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void query.refetch()}
              data-testid="decision-history-retry"
            >
              <RefreshCw className="size-4" /> 重试
            </Button>
          </span>
        )}
      </div>

      {query.isLoading ? (
        <div
          data-testid="decision-history-loading"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" /> 加载中…
        </div>
      ) : (
        <>
          <DecisionHistoryTable
            rows={rows}
            total={total}
            skippedInvalid={skippedInvalid}
            sourcesSummary={sourcesSummary}
          />
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                data-testid="decision-history-load-more"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                加载更多（已加载 {rows.length} / 共 {total}）
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
