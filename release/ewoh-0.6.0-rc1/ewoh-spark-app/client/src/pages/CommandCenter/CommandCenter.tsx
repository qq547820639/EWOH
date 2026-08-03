import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Cpu, Users } from 'lucide-react';
import { getEvents, getOverview } from '../../api/dashboard';
import type { EventInfo, OverviewStats } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

interface CommandCenterData {
  overview: OverviewStats;
  events: EventInfo[];
}

const CommandCenter = (): React.ReactElement => {
  const query = useQuery<CommandCenterData>({
    queryKey: queryKeys.commandCenter,
    queryFn: async () => {
      const [overview, events] = await Promise.all([getOverview(), getEvents(6)]);
      return { overview, events };
    },
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const data = query.data;
  const overview = data?.overview;
  const events = data?.events ?? [];

  const kpis = [
    { label: '设备总数', value: overview?.deviceTotal ?? 0, icon: Cpu },
    { label: '在线设备', value: overview?.deviceOnline ?? 0, icon: Activity },
    { label: '未关闭事件', value: overview?.eventOpen ?? 0, icon: AlertTriangle },
    { label: '重大事件', value: overview?.eventCritical ?? 0, icon: AlertTriangle },
    { label: '平均负荷', value: overview?.avgLoad ?? 0, icon: Users },
    { label: '作业人员', value: overview?.workerCount ?? 0, icon: Users },
  ];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">指挥中心</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            设备、事件、人员与班次生产态势总览。
          </p>
        </div>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!data}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载指挥中心数据"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {kpis.map((kpi) => {
              const Icon = kpi.icon;
              return (
                <div
                  key={kpi.label}
                  className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
                >
                  <div className="flex items-center gap-2 text-xs text-[hsl(218_10%_42%)]">
                    <Icon className="size-4" />
                    {kpi.label}
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-[hsl(220_14%_14%)]">
                    {kpi.value}
                  </div>
                </div>
              );
            })}
          </div>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">近期事件</h2>
            </div>
            {events.length === 0 ? (
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无事件记录。</div>
            ) : (
              <ul className="divide-y divide-[hsl(220_14%_89%)]">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                        {event.title || event.eventCode}
                      </p>
                      <p className="truncate text-xs text-[hsl(218_10%_42%)]">
                        {event.deviceId} · {event.severity} · {event.status}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">
                      {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </QueryState>
    </div>
  );
};

export default CommandCenter;
