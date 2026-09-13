import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { listOrderChains } from '../../api/world';
import { Badge } from '../../components/ui/badge';
import { parseError } from '../../lib/errorContract';
import { buildOrderChainRows, orderChainSummaryLabel } from './operationsLogic';

/**
 * 订单链卡片（NO-57a）：未完工订单的「订单 → 任务/工序 → 物料」链路。
 *
 * 为什么需要：世界快照早就有订单与物料行，但**链路没有消费面**——投影里
 * `taskIds`/`remainingOperations` 被写死为空，看板/解释都以为"订单没有任务"。
 * 这张卡把链路和**断链缺口**一起显示出来：缺口不静默省略（原则 7）。
 */
export function OrderChainCard(): React.ReactElement {
  const chainsQuery = useQuery({
    queryKey: ['world', 'order-chains'],
    queryFn: () => listOrderChains({ limit: 12 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const rows = buildOrderChainRows(chainsQuery.data);

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-labelledby="order-chain-title"
      data-testid="order-chain"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="order-chain-title" className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4" /> 订单链（订单 → 任务/工序 → 物料）
        </h2>
        <Badge variant={rows.some((row) => row.overdue) ? 'destructive' : 'outline'}>
          未完工 {rows.length} 单
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="order-chain-summary">
        {orderChainSummaryLabel(chainsQuery.data)}
      </p>
      {chainsQuery.isError && (
        <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert" data-testid="order-chain-error">
          订单链读取失败（{parseError(chainsQuery.error).message}）——这里不会显示成"没有订单"。
        </p>
      )}
      {!chainsQuery.isLoading && !chainsQuery.isError && rows.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="order-chain-empty">
          没有未完工订单（无数据 ≠ 现场没有活；先确认 ERP_ORDER 是否有上行）
        </p>
      )}
      <ul className="mt-3 divide-y divide-border">
        {rows.map((row) => (
          <li key={row.orderNo} className="py-2.5" data-testid="order-chain-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {row.overdue && <Badge variant="destructive">已逾期</Badge>}
                <span className="truncate text-sm font-medium">{row.orderNo}</span>
                <span className="text-xs text-muted-foreground">{row.statusLabel}</span>
              </div>
              <span className="text-xs text-muted-foreground">交付 {row.dueLabel}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="order-chain-links">
              {row.taskLabel} · {row.materialLabel}
            </p>
            {row.noteLabels.length > 0 && (
              <ul className="mt-0.5 space-y-0.5" data-testid="order-chain-notes">
                {row.noteLabels.map((note) => (
                  <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
                ))}
              </ul>
            )}
            {row.gapLabels.length > 0 && (
              <ul className="mt-0.5 space-y-0.5" data-testid="order-chain-gaps">
                {row.gapLabels.map((gap) => (
                  <li key={gap} className="text-[11px] text-risk-degraded-foreground">· 链路缺口：{gap}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default OrderChainCard;
