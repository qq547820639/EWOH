import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyPlanOverrides } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type { PlanOverrideRequest, PlanOverrideResponse } from '@shared/api.interface';

/**
 * 人工覆盖 Mutation Hook（V2 闭环）。
 *
 * 将人工操作（锁定/排除/偏好/加急/调时）提交到 `POST /plans/:planId/overrides`，
 * 触发既有 V2 重排，并在成功后失效活跃方案 / 方案列表 / 单方案缓存。
 */
export function usePlanOverrides(planId: string | null | undefined) {
  const queryClient = useQueryClient();

  const mutation = useMutation<PlanOverrideResponse, Error, PlanOverrideRequest>({
    mutationFn: (body) => {
      if (!planId) {
        return Promise.reject(new Error('请先选择活动方案'));
      }
      return applyPlanOverrides(planId, body);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerActivePlans });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlans() });
      if (planId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlan(planId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlan(res.planId) });
      }
    },
  });

  return mutation;
}