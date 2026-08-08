import { useQuery } from '@tanstack/react-query';
import { getConflicts } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type {
  ConflictsListRequest,
  ConflictsListResponse,
  SchedulingConflict,
} from '@shared/api.interface';

/**
 * 统一调度冲突 Hook（V2）。
 *
 * 消费后端 `GET /api/scheduler/conflicts`，返回由后端从真实世界状态 / 预占 /
 * 活跃方案聚合推导的统一冲突源，供命令图冲突面板 / 冲突中心消费。
 * 无冲突时返回空列表（后端不虚构）。
 */
export function useSchedulerConflicts(
  filters?: ConflictsListRequest,
  options?: { enabled?: boolean; refetchInterval?: number },
): {
  conflicts: SchedulingConflict[];
  total: number;
  isLoading: boolean;
  isError: boolean;
} {
  const { data, isLoading, isError } = useQuery<ConflictsListResponse>({
    queryKey: queryKeys.schedulerConflicts(filters),
    queryFn: () => getConflicts(filters),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? 30_000,
  });

  return {
    conflicts: data?.conflicts ?? [],
    total: data?.total ?? 0,
    isLoading,
    isError,
  };
}