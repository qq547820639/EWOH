import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getOverview, getEventsPage } from '../../api/dashboard';
import type { OverviewStats, EventInfo } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { PageDutyHeader } from '../../components/app-shell/PageDutyHeader';
import { CommandCenterView, EVENT_PAGE_SIZE_OPTIONS } from './CommandCenterView';

const CommandCenter = (): React.ReactElement => {
  // 近期事件分页状态（2026-08-21：固定 6 条 → 分页列表）。
  // 切页大小重置回第 1 页；offset=(page-1)*pageSize；翻页保留上页数据防闪烁。
  const [eventPage, setEventPage] = useState(1);
  const [eventPageSize, setEventPageSize] = useState<number>(20);

  const overviewQuery = useQuery<OverviewStats>({
    queryKey: queryKeys.commandCenterOverview,
    queryFn: getOverview,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const eventsQuery = useQuery<{ items: EventInfo[]; total: number }>({
    queryKey: [...queryKeys.commandCenterEvents, eventPage, eventPageSize],
    queryFn: () =>
      getEventsPage(eventPageSize, undefined, 24, (eventPage - 1) * eventPageSize),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
    placeholderData: (prev) => prev,
  });

  const totalEvents = eventsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalEvents / eventPageSize));
  const goEventPage = (page: number) => {
    setEventPage(Math.min(Math.max(1, page), totalPages));
  };
  const changeEventPageSize = (size: number) => {
    setEventPageSize(size);
    setEventPage(1);
  };

  // 首载/整体加载态由 overview 主导（事件查询独立，失败不阻断 KPI 展示）。
  const query = {
    isLoading: overviewQuery.isLoading,
    isFetching: overviewQuery.isFetching || eventsQuery.isFetching,
    isError: overviewQuery.isError,
    isStale: overviewQuery.isStale,
    dataUpdatedAt: overviewQuery.dataUpdatedAt,
    refetch: () => {
      void overviewQuery.refetch();
      void eventsQuery.refetch();
    },
  };

  return (
    // 2026-08-21 响应式：根容器撑满 main（flex-1 flex-col），内部 flex 布局
    // 管理滚动，避免内容不足时底部大片空白。
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden p-4 sm:p-6">
      {/* DR-1 轻量收敛：页头职责条（j2-design-spec-addendum §4） */}
      <PageDutyHeader currentPath="/command-center" />
      <header className="flex flex-wrap items-end justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-foreground">指挥中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            设备、事件、人员与班次生产态势总览。
          </p>
        </div>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!overviewQuery.data}
        onRefresh={() => query.refetch()}
        error={overviewQuery.error}
        errorMessage={
          overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : '数据加载失败'
        }
        backHref="/command-center"
        loadingMessage="正在加载指挥中心数据"
        updatedAt={query.dataUpdatedAt}
      >
        {/* NO-13ae / ADR-080：纯展示视图（KPI 派生 + 分页事件列表，零网络）。 */}
        <CommandCenterView
          overview={overviewQuery.data}
          events={eventsQuery.data?.items ?? []}
          totalEvents={totalEvents}
          page={eventPage}
          pageSize={eventPageSize}
          totalPages={totalPages}
          onPageChange={goEventPage}
          onPageSizeChange={changeEventPageSize}
          isEventsLoading={eventsQuery.isLoading}
        />
      </QueryState>
    </div>
  );
};

export default CommandCenter;
