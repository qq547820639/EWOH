import { useQuery } from '@tanstack/react-query';
import { Boxes, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { errorDescription } from '@client/src/lib/errorContract';
import { getMaterialInventory } from '@client/src/api/materials';

/**
 * 物料与库存（NO-27a / NO-28a）。
 *
 * 这一页回答现场真正会问的三个问题（原则 1/5）：
 *   1. 现在还有多少？（库存来自 ERP 出站事件的**投影**，每行可追到单据）
 *   2. 缺不缺、影响谁？（结合未完工订单 BOM 的需求与再订货点，给出缺口与受影响订单号）
 *   3. 为什么没判定？（未声明再订货点 / 计量单位不一致 / 只有需求没有出入库记录 /
 *      历史载荷不可解析 —— 全部如实列出，不静默）
 *
 * 页面**不做任何推断**：所有数字来自服务端投影，前端只负责分层展示与措辞。
 */
export default function Materials() {
  const inventoryQuery = useQuery({
    queryKey: ['materials', 'inventory'],
    queryFn: getMaterialInventory,
    refetchInterval: 60000,
  });

  const data = inventoryQuery.data;
  const impact = data?.impact ?? [];
  const actionable = impact.filter((row) => row.status === 'below_demand' || row.status === 'below_threshold');
  const unknown = impact.filter((row) =>
    ['no_threshold', 'mixed_units', 'no_movements', 'unit_mismatch'].includes(row.status),
  );

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">物料与库存</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="materials-summary">
              {data
                ? `物料 ${impact.length} 项｜需要处置 ${actionable.length} 项｜无法判定 ${unknown.length} 项`
                : '库存来自 ERP 出入库事件的投影（入库累加、领用累减），需求来自未完工订单 BOM。'}
            </p>
            {data && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="materials-provenance">
                生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')} · 扫描出站事件{' '}
                {data.scannedEvents} 条（其中物料流动 {data.movementEvents} 条）· 扫描订单{' '}
                {data.scannedOrders} 条
              </p>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          data-testid="materials-refresh"
          disabled={inventoryQuery.isFetching}
          onClick={() => inventoryQuery.refetch()}
        >
          <RefreshCw className="mr-1 h-4 w-4" />
          {inventoryQuery.isFetching ? '刷新中…' : '刷新'}
        </Button>
      </header>

      {data?.ordersTruncated && (
        <div
          className="rounded-lg border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground"
          data-testid="materials-orders-truncated"
        >
          订单需求**可能不完整**：只扫描了最近一批订单（{data.aggregationNote ?? '触到扫描上限'}）。
          请以 ERP 未完工订单清单为准，或分批处理。
        </div>
      )}

      {inventoryQuery.isError && (
        <div
          className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked-foreground"
          data-testid="materials-error-banner"
        >
          库存读取失败：{errorDescription(inventoryQuery.error)}
        </div>
      )}

      <section data-testid="materials-impact">
        <h2 className="mb-3 text-lg font-semibold text-foreground">库存与缺口</h2>
        {/* 出错时不再显示"加载中…"（会话式假状态会让人以为数据马上就来） */}
        {!data && inventoryQuery.isLoading && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">加载中…</div>
        )}
        {!data && inventoryQuery.isError && (
          <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-6 text-sm text-risk-blocked-foreground" data-testid="materials-error">
            库存不可用：读取失败（不是"没有物料"，请先修复数据源或稍后重试）
          </div>
        )}
        {data && impact.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground" data-testid="materials-empty">
            当前没有物料记录：ERP 出入库事件与订单 BOM 都为空（不会凭空生成物料）。
          </div>
        )}
        {impact.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">物料</th>
                  <th className="px-3 py-2 text-right">现有量</th>
                  <th className="px-3 py-2 text-right">再订货点</th>
                  <th className="px-3 py-2 text-right">未完工需求</th>
                  <th className="px-3 py-2 text-right">缺口</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-left">影响面</th>
                </tr>
              </thead>
              <tbody>
                {impact.map((row) => (
                  <tr key={row.materialId} className="border-t border-border" data-testid={`material-row-${row.materialId}`}>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{row.materialId}</td>
                    <td className="px-3 py-2 text-right">
                      {row.onHand === null ? '未知' : `${row.onHand}${row.unit ? ` ${row.unit}` : ''}`}
                    </td>
                    <td className="px-3 py-2 text-right">{row.minThreshold ?? '未声明'}</td>
                    <td className="px-3 py-2 text-right">
                      {row.requiredQuantity === null ? '—' : row.requiredQuantity}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.demandGap !== null && row.demandGap > 0 ? (
                        <span className="text-risk-blocked-foreground">差 {row.demandGap}</span>
                      ) : row.thresholdGap !== null && row.thresholdGap > 0 ? (
                        <span className="text-risk-degraded-foreground">低于阈值 {row.thresholdGap}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        data-testid={`material-status-${row.materialId}`}
                        className={
                          row.status === 'below_demand' || row.status === 'below_threshold'
                            ? 'border-risk-blocked-border text-risk-blocked-foreground'
                            : undefined
                        }
                      >
                        {row.statusLabel}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.affectedOrders.length === 0
                        ? '—'
                        : row.affectedOrders
                            .map(
                              (order) =>
                                `${order.externalOrderId}（需 ${order.requiredQuantity}${
                                  order.dueAt ? `，${new Date(order.dueAt).toLocaleDateString('zh-CN')}` : ''
                                }）`,
                            )
                            .join('；')}
                      {row.hasOverdue && (
                        <span className="ml-1 text-risk-degraded-foreground" data-testid={`material-overdue-${row.materialId}`}>
                          <TriangleAlert className="mr-0.5 inline h-3 w-3" />
                          含逾期订单
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && (data.demand.unknownBasisOrders.length > 0 || data.demand.invalidOrders.length > 0) && (
        <section data-testid="materials-demand-gaps">
          <h2 className="mb-3 text-lg font-semibold text-foreground">未纳入需求计算的订单</h2>
          <ul className="space-y-1 text-xs">
            {data.demand.unknownBasisOrders.map((order) => (
              <li key={order.eventId} className="rounded border border-border bg-card px-3 py-2" data-testid={`materials-unknown-basis-${order.eventId}`}>
                <span className="font-mono text-foreground">{order.externalOrderId}</span>
                <span className="ml-2 text-risk-degraded-foreground">BOM 口径未声明</span>
                <span className="ml-2 text-muted-foreground">{order.reason}</span>
              </li>
            ))}
            {data.demand.invalidOrders.map((order) => (
              <li key={`${order.eventId}-${order.reason}`} className="rounded border border-border bg-card px-3 py-2">
                <span className="font-mono text-foreground">{order.externalOrderId}</span>
                <span className="ml-2 text-risk-blocked-foreground">数据非法</span>
                <span className="ml-2 text-muted-foreground">{order.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.unparsable.length > 0 && (
        <section data-testid="materials-unparsable">
          <h2 className="mb-3 text-lg font-semibold text-foreground">无法解析的历史出入库载荷（{data.unparsable.length}）</h2>
          <ul className="space-y-1 text-xs">
            {data.unparsable.map((row) => (
              <li key={row.eventId} className="rounded border border-border bg-card px-3 py-2">
                <span className="font-mono text-foreground">{row.eventId}</span>
                <span className="ml-2 text-muted-foreground">{row.type}</span>
                <span className="ml-2 text-risk-degraded-foreground">{row.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
