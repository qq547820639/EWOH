import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { listAlerts, transitionAlert, type AlertRecord } from '../../api/alerts';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import OfflineState from '../../components/OfflineState';
import { Button } from '@client/src/components/ui/button';

const statusLabel: Record<string, string> = {
  open: '待确认',
  acknowledged: '已确认',
  processing: '处置中',
  closed: '已关闭',
  reopened: '已重开',
};

const actionFor = (status: string | null): { label: string; action: string } => {
  switch (status) {
    case 'open':
      return { label: '确认', action: 'acknowledge' };
    case 'acknowledged':
      return { label: '处置', action: 'process' };
    case 'processing':
      return { label: '关闭', action: 'close' };
    case 'closed':
      return { label: '重开', action: 'reopen' };
    default:
      return { label: '确认', action: 'acknowledge' };
  }
};

const Alerts = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );

  useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const query = useQuery<AlertRecord[]>({
    queryKey: queryKeys.alerts,
    queryFn: listAlerts,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const transitionMutation = useMutation({
    mutationFn: ({ eventId, action }: { eventId: string; action: string }) =>
      transitionAlert(eventId, action),
    onSuccess: () => {
      toast.success('告警状态已更新');
      queryClient.invalidateQueries({ queryKey: queryKeys.alerts });
    },
    onError: (err) => {
      toast.error('状态更新失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">风险与告警</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">告警确认、处置、关闭与重开闭环。</p>
      </header>

      {isOffline && (
        <OfflineState
          title="当前处于离线状态"
          description="网络连接已断开，告警操作将加入待同步队列，联网后自动提交。"
          pendingCount={rows.length}
          onRetry={() => query.refetch()}
        />
      )}

      {transitionMutation.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {transitionMutation.error instanceof Error
            ? transitionMutation.error.message
            : '状态更新失败'}
        </div>
      )}

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载告警数据"
        emptyMessage="暂无告警记录。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">事件</th>
                <th className="px-5 py-3 font-medium">等级</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {rows.map((row) => {
                const next = actionFor(row.status);
                const busy =
                  transitionMutation.isPending && transitionMutation.variables?.eventId === row.eventId;
                return (
                  <tr key={row.id} className="hover:bg-[hsl(220_14%_96%)]">
                    <td className="px-5 py-3">
                      <p className="font-medium text-[hsl(220_14%_14%)]">{row.title ?? row.eventId}</p>
                      <p className="text-xs text-[hsl(218_10%_42%)]">{row.deviceId ?? '-'}</p>
                    </td>
                    <td className="px-5 py-3">{row.severity ?? '-'}</td>
                    <td className="px-5 py-3">{statusLabel[row.status ?? 'open'] ?? row.status}</td>
                    <td className="px-5 py-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          transitionMutation.mutate({ eventId: row.eventId, action: next.action })
                        }
                        className="inline-flex items-center gap-1.5"
                      >
                        {busy && <Loader2 className="size-3 animate-spin" />}
                        {busy ? '处理中' : next.label}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>
    </div>
  );
};

export default Alerts;
