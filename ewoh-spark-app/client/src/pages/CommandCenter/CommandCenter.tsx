import { useQuery } from '@tanstack/react-query';
import { getEvents, getOverview } from '../../api/dashboard';
import type { EventInfo, OverviewStats } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { CommandCenterView } from './CommandCenterView';

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
        error={query.error}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        backHref="/command-center"
        loadingMessage="正在加载指挥中心数据"
        updatedAt={query.dataUpdatedAt}
      >
        {/* NO-13ae / ADR-080：纯展示视图（KPI 派生 + 事件列表，零网络）。 */}
        <CommandCenterView overview={overview} events={events} />
      </QueryState>
    </div>
  );
};

export default CommandCenter;
