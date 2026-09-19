import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import {
  getDeliveryBacklogStatus,
  getDeliveryBacklogHistory,
  type DeliveryBacklogStatus,
  type DeliveryBacklogHistory,
} from '../../api/control';

/**
 * DeliveryBacklogTable —— 工厂级投递积压下钻表（NO-78a）。
 *
 * WorkbenchNow 的积压项是**一条聚合**；班组长/调度员点进来之后需要"哪台设备、
 * 几条、未交付几条、最久等多久、是否已升级"的逐设备明细——这就是下钻层。
 * 数据源：`GET /api/control/delivery-backlog/status`（只读快照，与巡检同一判定实现；
 * 服务端 5s TTL 缓存，前端 30s 轮询兜底）。
 *
 * 展示纪律（原则 5/6/7）：
 *   - 零积压不渲染表格（"0 台设备 0 条命令"的表是伪造需要处置）；
 *   - 升级（≥3× SLA）单列徽章，与普通积压区分；
 *   - 未交付 / 已投未回执分列（处置入口不同：前者查网关/密钥/配额，后者查设备侧）；
 *   - 读失败显式报错，不显示"一切正常"。
 */
export function DeliveryBacklogTable(): React.ReactElement {
  const query = useQuery({
    queryKey: ['delivery-backlog-status'],
    queryFn: () => getDeliveryBacklogStatus(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const historyQuery = useQuery({
    queryKey: ['delivery-backlog-history'],
    queryFn: () => getDeliveryBacklogHistory(24),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="backlog-table-loading">
        <Loader2 className="size-3 animate-spin" aria-hidden /> 正在读取投递积压…
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p className="text-sm text-risk-blocked-foreground" data-testid="backlog-table-error">
        投递积压读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}（不显示"一切正常"的假状态）
      </p>
    );
  }
  const snapshot = query.data;
  if (snapshot.totals.commands === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="backlog-table-empty">
        当前没有投递积压（SLA {Math.round(snapshot.slaMs / 60_000)} 分钟内的命令都已投出或有回执）。
      </p>
    );
  }

  const fmtWait = (ms: number) => {
    const minutes = Math.floor(ms / 60_000);
    return minutes >= 1 ? `${minutes} 分钟` : `${Math.round(ms / 1000)} 秒`;
  };

  return (
    <section className="space-y-2" data-testid="delivery-backlog-table">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">投递积压（逐设备）</span>
        <Badge variant="outline" className="text-risk-blocked-foreground">
          {snapshot.totals.devices} 台 / {snapshot.totals.commands} 条
        </Badge>
        {snapshot.totals.escalatedDevices > 0 && (
          <Badge variant="outline" className="text-risk-blocked-foreground">
            已升级 {snapshot.totals.escalatedDevices} 台
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          SLA {Math.round(snapshot.slaMs / 60_000)} 分钟（升级阈值 {snapshot.escalationMultiplier}×）
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-medium">设备</th>
            <th className="py-1 pr-2 font-medium">命令</th>
            <th className="py-1 pr-2 font-medium">未交付</th>
            <th className="py-1 pr-2 font-medium">已投未回执</th>
            <th className="py-1 pr-2 font-medium">最久等待</th>
            <th className="py-1 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.devices.map((device) => (
            <tr key={device.deviceId} className="border-t border-border">
              <td className="py-1 pr-2 font-mono text-xs">{device.deviceId}</td>
              <td className="py-1 pr-2">{device.commands}</td>
              <td className="py-1 pr-2 text-risk-blocked-foreground">{device.undelivered}</td>
              <td className="py-1 pr-2 text-risk-degraded-foreground">{device.receivedNotExecuted}</td>
              <td className="py-1 pr-2">{fmtWait(device.oldestWaitingMs)}</td>
              <td className="py-1">
                {device.escalated ? (
                  <span className="text-xs font-semibold text-risk-blocked-foreground">已升级</span>
                ) : (
                  <span className="text-xs text-muted-foreground">巡检跟踪中</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(() => {
        // NO-91a：积压趋势 sparkline（commands 计数随巡检节拍变化）
        const history: DeliveryBacklogHistory | undefined = historyQuery.data;
        if (!Array.isArray(history?.snapshots) || history.snapshots.length < 2) return null;
        const points = [...history.snapshots].reverse().map((s) => s.commands);
        const max = Math.max(...points, 1);
        const width = 220;
        const height = 28;
        const poly = points.map((v, i) => {
          const x = (i / (points.length - 1)) * width;
          const y = height - (v / max) * (height - 4) - 2;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        return (
          <svg width={width} height={height} className="block" role="img" aria-label="积压命令数趋势">
            <polyline points={poly} fill="none" stroke="currentColor" className="text-risk-degraded-foreground" strokeWidth="1.5" />
          </svg>
        );
      })()}
      <p className="text-xs text-muted-foreground">
        检查于 {new Date(snapshot.checkedAt).toLocaleTimeString()}（30s 自动刷新；未交付查网关/密钥/配额，已投未回执查设备侧）
      </p>
    </section>
  );
}

export default DeliveryBacklogTable;
