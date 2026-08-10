/* Phase 3 / P3-T3 前端：CommandMap 聚合状态 Hook。
 *
 * React Query 拉取权威数据（snapshot / resources / active plans / routes / conflicts），
 * useSchedulerStream 处理 SSE 增量 + gap→resync；聚合交给纯选择器 commandMapSelector
 * （node 可测）；本地只存 UI state。
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getSnapshot,
  getActivePlans,
  getUnifiedResourceState,
  getRoutes,
  getConflicts,
} from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  applyUiPatch,
  buildCommandMapState,
  DEFAULT_UI_STATE,
  type CommandMapAggregate,
  type CommandMapUIState,
} from './commandMapSelector';
import type { ConflictsListRequest } from '@shared/api.interface';

export type { CommandMapAggregate, CommandMapUIState, CommandMapLayer, PanelMode, Viewport } from './commandMapSelector';
export { DEFAULT_UI_STATE, applyUiPatch, buildCommandMapState } from './commandMapSelector';

export type CommandMapSchedulerState = CommandMapAggregate & {
  /**
   * 全页唯一 selection owner：CommandMap / SchedulePanel 等组件统一经它读写
   * selectedTaskId / selectedPlanId / selectedResourceId（局部 patch 合并）。
   * 禁止组件各自维护 selection 副本（消除双轨状态）。
   */
  updateUi: (patch: Partial<CommandMapUIState>) => void;
};

export function useCommandMapSchedulerState(): CommandMapSchedulerState {
  const [ui, setUi] = useState<CommandMapUIState>(DEFAULT_UI_STATE);

  // selection owner 写入入口：引用稳定（useCallback），组件可安全放入依赖数组。
  const updateUi = useCallback(
    (patch: Partial<CommandMapUIState>) => setUi((prev) => applyUiPatch(prev, patch)),
    [],
  );

  const snapshotQuery = useQuery({
    queryKey: queryKeys.schedulerSnapshot,
    queryFn: getSnapshot,
    staleTime: 15_000,
  });
  const resourcesQuery = useQuery({
    queryKey: queryKeys.schedulerResourceState,
    queryFn: getUnifiedResourceState,
    staleTime: 15_000,
  });
  const plansQuery = useQuery({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const routesQuery = useQuery({
    queryKey: ['scheduler-routes'],
    queryFn: getRoutes,
    staleTime: 60_000,
  });
  const conflictsQuery = useQuery({
    queryKey: queryKeys.schedulerConflicts({} as ConflictsListRequest),
    queryFn: () => getConflicts({}),
    staleTime: 10_000,
  });

  // 注意：SSE 增量订阅由 CommandMap 顶层的 SchedulerRealtimeProvider（单例）拥有，
  // 本 Hook 不再独立建立连接，仅消费 React Query 权威查询。
  const aggregate = useMemo(
    () =>
      buildCommandMapState({
        snapshot: snapshotQuery.data ?? null,
        resources: resourcesQuery.data,
        plans: plansQuery.data,
        routes: routesQuery.data,
        conflicts: conflictsQuery.data?.conflicts,
        ui,
        loading:
          snapshotQuery.isLoading ||
          resourcesQuery.isLoading ||
          plansQuery.isLoading ||
          conflictsQuery.isLoading,
        hasError:
          snapshotQuery.isError ||
          resourcesQuery.isError ||
          plansQuery.isError ||
          routesQuery.isError ||
          conflictsQuery.isError,
      }),
    [
      snapshotQuery.data,
      snapshotQuery.isLoading,
      snapshotQuery.isError,
      resourcesQuery.data,
      resourcesQuery.isLoading,
      resourcesQuery.isError,
      plansQuery.data,
      plansQuery.isLoading,
      plansQuery.isError,
      routesQuery.data,
      routesQuery.isError,
      conflictsQuery.data,
      conflictsQuery.isLoading,
      conflictsQuery.isError,
      ui,
    ],
  );

  return { ...aggregate, updateUi };
}
