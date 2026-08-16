/* DecisionHistoryConsole.tsx — 决策历史控制台（NO-13q / ADR-066，§17/§18）。
 *
 * Decision History 统一读面消费端：kind/status 过滤 + 分页（limit 50
 * "加载更多"）+ skippedInvalid 显式横幅（§33）+ 错误/空/加载态。
 * 服务端排序为权威（客户端零聚合/排序）；展示层不做二次解释。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: [queryKeys.decisions, kind, status, offset],
    queryFn: () =>
      fetchDecisionHistory({
        kind: kind || undefined,
        status: status || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const items = query.data?.items ?? [];
  const rows = buildDecisionRows(items);
  const total = query.data?.total ?? 0;
  const skippedInvalid = query.data?.skippedInvalid ?? 0;
  const sourcesSummary = query.data
    ? buildSourcesSummary(query.data.sources)
    : '';

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <History className="size-5 text-[hsl(220_14%_14%)]" />
        <h1 className="text-lg font-semibold text-[hsl(220_14%_14%)]">决策历史</h1>
        <span className="text-xs text-[hsl(218_10%_42%)]">
          Decision Catalog 8 类 kind 统一读面（ADR-065）
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-[hsl(220_14%_14%)]">
          类型
          <select
            data-testid="decision-history-kind-filter"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
            className="rounded border border-[hsl(220_14%_89%)] px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-[hsl(220_14%_14%)]">
          状态
          <select
            data-testid="decision-history-status-filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            className="rounded border border-[hsl(220_14%_89%)] px-2 py-1 text-sm"
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
          className="flex items-center gap-2 text-sm text-[hsl(218_10%_42%)]"
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
          {offset + rows.length < total && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                data-testid="decision-history-load-more"
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                加载更多（已显示 {offset + rows.length} / {total}）
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
