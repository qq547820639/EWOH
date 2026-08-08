import { axiosForBackend } from '../lib/http';
import type {
  SchedulePlan,
  ScheduleAudit,
  ScheduleWeights,
  GeneratePlansRequest,
  ConfirmPlanRequest,
  SchedulingRun,
  SchedulingPlanV2,
  CreateRunRequest,
  ApprovePlanRequest,
  RejectPlanRequest,
  ReplanRequest,
  RouteGraph,
  Route,
  CalculateRouteRequest,
  TaskCandidatesResponse,
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

// ===== Scheduling V2 (智能调度工作台) =====

/** 触发一次调度运行并生成方案（返回 run + 生成的 plans）。 */
export async function createRun(
  body?: CreateRunRequest,
): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
  const res = await axiosForBackend({
    url: '/api/scheduler/runs',
    method: 'POST',
    data: body ?? {},
  });
  return res.data;
}

/** 查询调度运行记录。 */
export async function getRun(runId: string): Promise<SchedulingRun | null> {
  const res = await axiosForBackend({ url: `/api/scheduler/runs/${runId}`, method: 'GET' });
  return res.data;
}

/**
 * 获取当前「活跃方案」列表（V2）。
 *
 * 说明：V2 后端未提供独立的“活跃方案”列表端点，活跃方案由两部分维护——
 * 1) `createRun` 的返回结果（新生成的方案）写入 React Query 缓存；
 * 2) 调度 SSE 事件流（`/api/scheduler/v2/stream`）按 sequence 增量同步。
 * 因此本函数在首次加载时返回空列表作为初始态，具体方案数据经上述通道进入
 * `queryKeys.schedulerActivePlans` 缓存，供界面读取。
 */
export async function getActivePlans(): Promise<SchedulingPlanV2[]> {
  const cached = await Promise.resolve<SchedulingPlanV2[]>([]);
  return cached;
}

/** 获取完整方案（含分配明细）。 */
export async function getPlan(planId: string): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({ url: `/api/scheduler/plans/${planId}`, method: 'GET' });
  return res.data;
}

/** 审批方案（需携带 version + snapshotVersion，过期返回 409 PLAN_STALE）。 */
export async function approvePlan(
  planId: string,
  body: ApprovePlanRequest,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/approve`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/** 驳回方案（V2）。 */
export async function rejectPlanV2(
  planId: string,
  body: RejectPlanRequest,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/reject`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/** 下发方案（V2）。 */
export async function dispatchPlanV2(
  planId: string,
  operator?: string,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/dispatch`,
    method: 'POST',
    data: operator ? { operator } : {},
  });
  return res.data;
}

/** 带锁定约束重新排程（返回新方案，旧方案标记 superseded）。 */
export async function replan(
  planId: string,
  body: ReplanRequest,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/replan`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/** 对比两个方案（分配与指标差异）。 */
export async function comparePlans(
  planId: string,
  otherPlanId: string,
): Promise<Record<string, unknown>> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/compare/${otherPlanId}`,
    method: 'GET',
  });
  return res.data;
}

/** 获取路由图（节点 + 边）。 */
export async function getRoutes(): Promise<RouteGraph> {
  const res = await axiosForBackend({ url: '/api/scheduler/routes', method: 'GET' });
  return res.data;
}

/**
 * 获取某任务的候选资源（人员×设备），由后端资格判定 + 路径可行性计算。
 *
 * 说明：前端仅展示后端返回的候选/排除原因，不自行复算资格或优先级。
 */
export async function getTaskCandidates(
  taskId: string,
): Promise<TaskCandidatesResponse> {
  const res = await axiosForBackend({
    url: `/api/scheduler/tasks/${taskId}/candidates`,
    method: 'GET',
  });
  return res.data;
}

/** 计算单条路径。 */
export async function calculateRoute(body: CalculateRouteRequest): Promise<Route> {
  const res = await axiosForBackend({
    url: '/api/scheduler/routes/calculate',
    method: 'POST',
    data: body,
  });
  return res.data;
}
