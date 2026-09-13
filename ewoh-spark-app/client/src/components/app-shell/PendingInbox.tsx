import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getEventsPage } from '../../api/dashboard';
import { getActivePlans } from '../../api/scheduler';
import type { SchedulingPlanV2 } from '@shared/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import { OPERATIONAL_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';

/**
 * 未处理事项收件箱（DR-2 真实化，2026-09-11）。
 *
 * 三类真实计数（离线队列 + open 异常 + 待审批方案）：
 *  - 离线队列待同步数（countPending，调用方注入）；
 *  - 近 24h open 事件数（/api/dashboard/events）；
 *  - draft 状态方案数（/api/scheduler/active-plans）。
 * 徽标 = 三者之和；点击直达对应工作台。计数失败如实显示"—"（不冒充 0）。
 */
const PendingInbox = ({ pendingCount }: { pendingCount: number }) => {
  const navigate = useNavigate();

  const eventsQuery = useQuery({
    queryKey: queryKeys.factoryOperationsEvents(1, 1),
    queryFn: () => getEventsPage(1, 'open', 24, 0),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const plansQuery = useQuery<SchedulingPlanV2[]>({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });

  const openAlerts = eventsQuery.isError ? null : (eventsQuery.data?.total ?? null);
  const pendingPlans = plansQuery.isError
    ? null
    : (plansQuery.data?.filter((p) => p.status === 'draft').length ?? null);
  const badge =
    openAlerts === null || pendingPlans === null ? null : pendingCount + openAlerts + pendingPlans;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`待处理事项${badge != null && badge > 0 ? `，共 ${badge} 条` : ''}`}
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Inbox className="h-4 w-4" aria-hidden />
          {badge != null && badge > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
              aria-hidden
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>待处理事项</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => navigate('/shift-workbench')}>
          当班异常 {openAlerts ?? '—'} 条（近 24h open）
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/scheduling')}>
          待审批方案 {pendingPlans ?? '—'} 个
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/alerts')}>风险告警中心</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          待同步 {pendingCount} 条（离线队列）
        </DropdownMenuItem>
        {(openAlerts === null || pendingPlans === null) && (
          <DropdownMenuItem disabled>
            部分计数获取失败（— 表示不可用，不代表 0）
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default PendingInbox;
