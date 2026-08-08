import { axiosForBackend } from '../lib/http';
import type {
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
  ListRunsRequest,
  ListRunsResponse,
  WorldStateSnapshot,
  ConflictsListRequest,
  ConflictsListResponse,
  SchedulingConflict,
  PlanOverrideRequest,
  PlanOverrideResponse,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  SchedulingPolicyVersionSummary,
  SchedulingPolicyComparison,
  ResourceState,
} from '@shared/api.interface';

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

/** 分页查询调度运行历史 + 当前活跃方案列表（V2）。 */
export async function getRuns(params?: ListRunsRequest): Promise<ListRunsResponse> {
  const query: Record<string, string> = {};
  if (params?.status) query.status = params.status;
  if (params?.page != null) query.page = String(params.page);
  if (params?.pageSize != null) query.pageSize = String(params.pageSize);
  if (params?.from) query.from = params.from;
  if (params?.to) query.to = params.to;
  const res = await axiosForBackend({ url: '/api/scheduler/runs', method: 'GET', params: query });
  return res.data;
}

/** 获取 map 与调度共享的当前权威世界状态快照（V2）。 */
export async function getSnapshot(): Promise<WorldStateSnapshot> {
  const res = await axiosForBackend({ url: '/api/scheduler/snapshot', method: 'GET' });
  return res.data;
}

/**
 * P0-1：获取服务端权威活跃方案列表（非终态：shadow/approved/dispatched/executing）。
 *
 * 页面刷新 / SSE gap resync / 多终端必须从此端点拉取权威方案；SSE 事件流
 * （`/api/scheduler/v2/stream`）仅作为增量更新机制，不作为唯一状态源。
 */
export async function getActivePlans(): Promise<SchedulingPlanV2[]> {
  const res = await axiosForBackend({
    url: '/api/scheduler/active-plans',
    method: 'GET',
  });
  return res.data;
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

/**
 * 应用人工覆盖（锁定/排除/偏好/加急/调时）并触发 V2 重排。
 * 返回覆盖前后方案（before/after）及差异摘要（diff）。
 */
export async function applyPlanOverrides(
  planId: string,
  body: PlanOverrideRequest,
): Promise<PlanOverrideResponse> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${planId}/overrides`,
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

/**
 * P1-CMAP-002：统一资源状态权威投影（ResourceProjection SSOT）。
 * 前端 ResourcePool / Map 不得自行拼装 SpatialEntity/DeviceInfo 作为正式资源状态。
 */
export async function getUnifiedResourceState(): Promise<ResourceState[]> {
  const res = await axiosForBackend({
    url: '/api/scheduler/resources/state',
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

/** 查询统一调度冲突列表（V2，由后端聚合真实世界状态/预占/方案推导）。 */
export async function getConflicts(
  params?: ConflictsListRequest,
): Promise<ConflictsListResponse> {
  const query: Record<string, string> = {};
  if (params?.type) query.type = params.type;
  if (params?.severity) query.severity = params.severity;
  if (params?.scope) query.scope = params.scope;
  if (params?.resourceId) query.resourceId = params.resourceId;
  const res = await axiosForBackend({
    url: '/api/scheduler/conflicts',
    method: 'GET',
    params: query,
  });
  return res.data;
}

/** 查询单个调度冲突详情（V2）。 */
export async function getConflictDetail(
  conflictId: string,
): Promise<SchedulingConflict> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${conflictId}`,
    method: 'GET',
  });
  return res.data;
}

// ===== SchedulingPolicy 版本闭环 (Task 6) =====

/** 返回当前生效策略 + 配置（只读）。 */
export async function getPolicy(): Promise<{
  policy: SchedulingPolicy;
  config: SchedulingPolicyConfig;
}> {
  const res = await axiosForBackend({ url: '/api/scheduler/policy', method: 'GET' });
  return res.data;
}

/** 列出全部策略版本（含 active 标志、操作人、创建时间）。 */
export async function listPolicyVersions(): Promise<
  SchedulingPolicyVersionSummary[]
> {
  const res = await axiosForBackend({
    url: '/api/scheduler/policy/versions',
    method: 'GET',
  });
  return res.data;
}

/** 注册候选策略版本（inactive，绝不自动激活）。 */
export async function registerPolicyVersion(
  config: SchedulingPolicyConfig,
  operator?: string,
): Promise<SchedulingPolicyConfig> {
  const res = await axiosForBackend({
    url: '/api/scheduler/policy/versions',
    method: 'POST',
    data: { config, operator },
  });
  return res.data;
}

/** shadow/只读对比：候选版本 vs 当前生效版本（反馈 KPI + 目标权重）。 */
export async function comparePolicyVersion(
  version: number,
): Promise<SchedulingPolicyComparison> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/versions/${version}/compare`,
    method: 'GET',
  });
  return res.data;
}

/** 显式激活指定版本（唯一生产策略翻转路径，需人工审批 + 审计）。 */
export async function activatePolicyVersion(
  version: number,
  operator?: string,
): Promise<{ config: SchedulingPolicyConfig }> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/versions/${version}/activate`,
    method: 'POST',
    data: operator ? { operator } : {},
  });
  return res.data;
}
