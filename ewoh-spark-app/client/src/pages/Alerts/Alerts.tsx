import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { errorDescription } from '@client/src/lib/errorContract';
import { getAuthUser } from '../../lib/auth';
import { availableAlertActions } from './alertActions';

const statusLabel: Record<string, string> = {
  open: '待确认',
  acknowledged: '已确认',
  processing: '处置中',
  closed: '已关闭',
  reopened: '已重开',
};

// 注：原 `actionFor(status)` 只按状态返回动作、不看角色，而后端状态机是角色感知
// fail-closed 的，导致「按钮可点、点击必 400」，且 `reopened` 态漏掉了「处置」。
// 已整体移除，改用 `./alertActions` 的 availableAlertActions()——
// 判定委托给 @shared/alert-state-machine（与后端同一套规则），不硬编码角色矩阵。

const Alerts = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // 仅用于前端动作可用性判定，授权仍以服务端为准（lib/auth 注释：roles 只驱动 UI 展示）。
  const userRoles = getAuthUser()?.roles ?? null;
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
        description: errorDescription(err),
      });
    },
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">风险与告警</h1>
        <p className="mt-1 text-sm text-muted-foreground">告警确认、处置、关闭与重开闭环。</p>
      </header>

      {isOffline && (
        <OfflineState
          title="当前处于离线状态"
          description="当前离线，部分操作可能失败，请稍后重试。"
          onRetry={() => query.refetch()}
        />
      )}

      {/* 语义 Token（横切 X-3）：使暗色 / 高对比 / 反色三套主题对该区域生效。 */}
      {transitionMutation.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-risk-blocked-border bg-risk-blocked-soft p-4 text-sm text-risk-blocked-foreground">
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
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">事件</th>
                <th className="px-5 py-3 font-medium">等级</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                // 按「状态 × 当前用户角色」派生，不展示必被后端拒绝的动作。
                const actions = availableAlertActions(row.status, userRoles);
                const busyFor = (action: string): boolean =>
                  transitionMutation.isPending &&
                  transitionMutation.variables?.eventId === row.eventId &&
                  transitionMutation.variables?.action === action;
                return (
                  <tr key={row.id} className="hover:bg-muted">
                    <td className="px-5 py-3">
                      {/* RK-3：行标题下钻对象工作台（J2）；角色感知动作仍在本页内联 */}
                      <button
                        type="button"
                        onClick={() => navigate(`/o/alert/${encodeURIComponent(row.eventId)}`)}
                        className="text-left font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
                      >
                        {row.title ?? row.eventId}
                      </button>
                      <p className="text-xs text-muted-foreground">{row.deviceId ?? '-'}</p>
                    </td>
                    <td className="px-5 py-3">{row.severity ?? '-'}</td>
                    <td className="px-5 py-3">{statusLabel[row.status ?? 'open'] ?? row.status}</td>
                    <td className="px-5 py-3">
                      {actions.length === 0 ? (
                        // 无可用动作时给出明确说明，而不是留白或堆叠禁用按钮。
                        <span className="text-xs text-muted-foreground">
                          当前角色无可执行操作
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {actions.map((action) => (
                            <Button
                              key={action.action}
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busyFor(action.action)}
                              onClick={() =>
                                transitionMutation.mutate({
                                  eventId: row.eventId,
                                  action: action.action,
                                })
                              }
                              className="inline-flex items-center gap-1.5"
                            >
                              {busyFor(action.action) && (
                                <Loader2 className="size-3 animate-spin" />
                              )}
                              {busyFor(action.action) ? '处理中' : action.label}
                            </Button>
                          ))}
                        </div>
                      )}
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
