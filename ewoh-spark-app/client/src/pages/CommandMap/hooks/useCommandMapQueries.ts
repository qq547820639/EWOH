/* CLI-004 拆分：CommandMapShell 的全部 React Query 事实源查询（机械提取，行为不变）。
 *
 * - 静态空间实体 30s / 世界状态 10s（CLI-009：2s→10s 降频）/ KPI 5s /
 *   回放快照 30s（回放中冻结）/ 环境数据 30s；
 * - 组织/人员/设备/事件/路由图/任务候选（staleTime 统一 QUERY_STALE_TIME_MS）；
 * - querySnapshots + failedQueries（DataStates 降级横幅与重试）。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getEntities } from '../../../api/spatial';
import { getWorldState, getReplay } from '../../../api/world';
import { getRoutes, getTaskCandidates } from '../../../api/scheduler';
import {
  getOverview,
  getEvents,
  getEnvironmentSummary,
  searchDevices,
} from '../../../api/dashboard';
import { listOrganizations, listPersonnel } from '../../../api/organization';
import type {
  CurrentWorldState,
  DeviceInfo,
  EnvironmentReading,
  EventInfo,
  OrganizationInfo,
  OverviewStats,
  PersonnelInfo,
  ReplaySnapshot,
  RouteGraph,
  SpatialEntity,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '@client/src/hooks/queryConfig';
import {
  collectQueryErrors,
  type QueryStateSnapshot,
} from '../queryState';

export function useCommandMapQueries({
  replayMode,
  selectedTaskId,
  mode,
}: {
  replayMode: boolean;
  selectedTaskId: string | null;
  mode: string;
}) {
  // 静态空间实体，30 秒刷新
  const entitiesQuery = useQuery<SpatialEntity[]>({
    queryKey: queryKeys.spatialEntities,
    queryFn: () => getEntities(),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 动态世界状态，10 秒刷新（CLI-009：原 2s 高频轮询降频）
  const worldQuery = useQuery<CurrentWorldState>({
    queryKey: queryKeys.worldState,
    queryFn: ({ signal }) => getWorldState(signal),
    refetchInterval: 10000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // KPI，5 秒刷新
  const overviewQuery = useQuery<OverviewStats>({
    queryKey: queryKeys.overview,
    queryFn: getOverview,
    refetchInterval: 5000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 回放快照：非回放时 30 秒刷新，回放中冻结
  const replayQuery = useQuery<ReplaySnapshot[]>({
    queryKey: queryKeys.replaySnapshots,
    queryFn: ({ signal }) => getReplay(undefined, undefined, 120, signal),
    refetchInterval: replayMode ? 0 : 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const environmentQuery = useQuery<EnvironmentReading[]>({
    queryKey: queryKeys.environmentSummary,
    queryFn: getEnvironmentSummary,
    refetchInterval: 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const organizationsQuery = useQuery<OrganizationInfo[]>({
    queryKey: queryKeys.organizations,
    queryFn: listOrganizations,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const personnelQuery = useQuery<PersonnelInfo[]>({
    queryKey: queryKeys.personnel(),
    queryFn: () => listPersonnel(),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const devicesQuery = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices({ pageSize: 200 }),
    queryFn: () => searchDevices({ pageSize: 200 }),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const eventsQuery = useQuery<EventInfo[]>({
    queryKey: queryKeys.events(),
    queryFn: () => getEvents(200),
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 调度路由图（供调度方案覆盖层渲染拥堵/阻断边）
  const routeGraphQuery = useQuery<RouteGraph>({
    queryKey: ['schedule-route-graph'],
    queryFn: getRoutes,
    refetchInterval: 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 智能调度驾驶舱：选中任务时拉取后端候选资源（只读展示，不本地复算资格）。
  const candidatesQuery = useQuery<TaskCandidatesResponse | null>({
    queryKey: queryKeys.schedulerTaskCandidates(selectedTaskId ?? 'none'),
    queryFn: () =>
      selectedTaskId
        ? getTaskCandidates(selectedTaskId)
        : Promise.resolve<TaskCandidatesResponse | null>(null),
    enabled: !!selectedTaskId && mode === 'scheduling',
    staleTime: QUERY_STALE_TIME_MS,
  });

  const querySnapshots = useMemo<QueryStateSnapshot[]>(
    () => [
      {
        key: 'entities',
        label: '空间实体',
        isError: entitiesQuery.isError,
        dataUpdatedAt: entitiesQuery.dataUpdatedAt,
        refetch: entitiesQuery.refetch,
      },
      {
        key: 'world',
        label: '世界状态',
        isError: worldQuery.isError,
        dataUpdatedAt: worldQuery.dataUpdatedAt,
        refetch: worldQuery.refetch,
      },
      {
        key: 'overview',
        label: '总览指标',
        isError: overviewQuery.isError,
        dataUpdatedAt: overviewQuery.dataUpdatedAt,
        refetch: overviewQuery.refetch,
      },
      {
        key: 'environment',
        label: '环境数据',
        isError: environmentQuery.isError,
        dataUpdatedAt: environmentQuery.dataUpdatedAt,
        refetch: environmentQuery.refetch,
      },
    ],
    [
      entitiesQuery.isError,
      entitiesQuery.dataUpdatedAt,
      entitiesQuery.refetch,
      worldQuery.isError,
      worldQuery.dataUpdatedAt,
      worldQuery.refetch,
      overviewQuery.isError,
      overviewQuery.dataUpdatedAt,
      overviewQuery.refetch,
      environmentQuery.isError,
      environmentQuery.dataUpdatedAt,
      environmentQuery.refetch,
    ],
  );
  const failedQueries = useMemo(
    () => collectQueryErrors(querySnapshots),
    [querySnapshots],
  );

  return {
    entitiesQuery,
    worldQuery,
    overviewQuery,
    replayQuery,
    environmentQuery,
    organizationsQuery,
    personnelQuery,
    devicesQuery,
    eventsQuery,
    routeGraphQuery,
    candidatesQuery,
    querySnapshots,
    failedQueries,
  };
}
