import { axiosForBackend } from '../lib/http';
import type {
  SchedulePlan,
  ScheduleAudit,
  ScheduleWeights,
  GeneratePlansRequest,
  ConfirmPlanRequest,
} from '@shared/api.interface';

export async function generatePlans(
  body?: GeneratePlansRequest,
): Promise<SchedulePlan[]> {
  const res = await axiosForBackend({
    url: '/api/scheduler/plans',
    method: 'POST',
    data: body ?? {},
  });
  return res.data;
}

export async function generateDataDrivenPlans(
  body?: GeneratePlansRequest,
): Promise<SchedulePlan[]> {
  const res = await axiosForBackend({
    url: '/api/scheduler/plans/data-driven',
    method: 'POST',
    data: body ?? {},
  });
  return res.data;
}

export async function getPlans(status?: string): Promise<SchedulePlan[]> {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  const res = await axiosForBackend({ url: '/api/scheduler/plans', method: 'GET', params });
  return res.data;
}

export async function confirmPlan(
  planId: string,
  body: ConfirmPlanRequest,
): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/confirm`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function rejectPlan(
  planId: string,
  body: ConfirmPlanRequest,
): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/reject`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getAudit(planId?: string): Promise<ScheduleAudit[]> {
  const params: Record<string, string> = {};
  if (planId) params.planId = planId;
  const res = await axiosForBackend({ url: '/api/scheduler/audit', method: 'GET', params });
  return res.data;
}

export async function getWeights(): Promise<ScheduleWeights> {
  const res = await axiosForBackend({ url: '/api/scheduler/weights', method: 'GET' });
  return res.data;
}

export async function updateWeights(
  weights: ScheduleWeights,
  operator?: string,
  reason?: string,
): Promise<ScheduleWeights> {
  const res = await axiosForBackend({
    url: '/api/scheduler/weights',
    method: 'PUT',
    data: { weights, operator, reason },
  });
  return res.data;
}
