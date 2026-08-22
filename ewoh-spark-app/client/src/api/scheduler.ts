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
  SchedulingContextResponse,
  PlanOverrideRequest,
  PlanOverrideResponse,
  OverridePreviewResponse,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  SchedulingPolicyVersionSummary,
  SchedulingPolicyComparison,
  ResourceState,
  SchedulingEventRequest,
  ExecutionUpdateRequest,
  SchedulingExecution,
  ExecutionListResponse,
  SchedulerKpiSnapshot,
  PlanCompareResult,
  ConflictPreviewRequest,
  ConflictPreviewResult,
  ReplanPreviewRequest,
  ReplanPreviewResult,
  PolicyReplayRequest,
  PolicyReplayRecord,
  PolicyGateEvaluation,
  PolicyActivationRecord,
} from '@shared/api.interface';

// ===== Scheduling V2 (智能调度工作台) =====

/** 触发一次调度运行并生成方案（返回 run + 生成的 plans）。 */
export async function createRun(
  body?: CreateRunRequest,
): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
  // 调度求解器 + 快照构建 + 候选枚举耗时较长（典型 30-90s），前端全局 15s 超时会必然失败。
  // 单独设置 120s 超时与后端实际处理时间匹配。
  const res = await axiosForBackend({
    url: '/api/scheduler/runs',
    method: 'POST',
    data: body ?? {},
    timeout: 120_000,
  });
  return res.data;
}

/**
 * v0.7 B2 事件驱动智能重排：注入真实业务事件（设备离线/路线阻断/安全事件等），
 * 触发 ReplanCoordinator 局部重排（仅重排受影响任务，无关任务不 churn）。
 * 幂等与冷却由后端 TriggerService 保证；失败自动熔断不抛错阻断事件源。
 */
export async function injectSchedulingEvent(
  body: SchedulingEventRequest,
): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
  // 事件驱动重排同样需要较长处理时间。
  const res = await axiosForBackend({
    url: '/api/scheduler/events',
    method: 'POST',
    data: body,
    timeout: 120_000,
  });
  return res.data;
}

/** 查询调度运行记录。 */
export async function getRun(runId: string): Promise<SchedulingRun | null> {
  const res = await axiosForBackend({ url: `/api/scheduler/runs/${encodeURIComponent(runId)}`, method: 'GET' });
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
  // 列表含活跃方案 assignments（slim 前可达 MB 级），公网传输 >15s 正常，必须覆盖全局 15s。
  const res = await axiosForBackend({
    url: '/api/scheduler/runs',
    method: 'GET',
    params: query,
    timeout: 120_000,
  });
  return res.data;
}

/** 获取 map 与调度共享的当前权威世界状态快照（V2）。 */
export async function getSnapshot(): Promise<WorldStateSnapshot> {
  const res = await axiosForBackend({ url: '/api/scheduler/snapshot', method: 'GET', timeout: 120_000 });
  return res.data;
}

/**
 * P0-1：获取服务端权威活跃方案列表（非终态：shadow/approved/dispatched/executing）。
 *
 * 页面刷新 / SSE gap resync / 多终端必须从此端点拉取权威方案；SSE 事件流
 * （`/api/scheduler/v2/stream`）仅作为增量更新机制，不作为唯一状态源。
 */
export async function getActivePlans(): Promise<SchedulingPlanV2[]> {
  // 活跃方案含 assignments（slim 前可达 MB 级），公网传输慢，必须覆盖全局 15s。
  const res = await axiosForBackend({
    url: '/api/scheduler/active-plans',
    method: 'GET',
    timeout: 120_000,
  });
  return res.data;
}

/**
 * P1-D：统一调度上下文（GET /api/scheduler/context，Phase 0 / P0-2 交付）。
 *
 * 单一 org 时间切片：snapshotVersion / resourceVersion / routeGraphVersion /
 * policyVersion / eventSequence / sourceTimestamp / tasks / resources /
 * reservations / constraints / dataQuality。Command Map 以它作为统一版本边界，
 * 判定 Plan/Resource 版本一致性（STALE CONTEXT），禁止跨切片混合展示。
 */
export async function getSchedulerContext(): Promise<SchedulingContextResponse> {
  const res = await axiosForBackend({ url: '/api/scheduler/context', method: 'GET', timeout: 120_000 });
  return res.data;
}

/** 获取完整方案（含分配明细，decisionTrace 可达几十 KB/条）。 */
export async function getPlan(planId: string): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({ url: `/api/scheduler/plans/${encodeURIComponent(planId)}`, method: 'GET', timeout: 120_000 });
  return res.data;
}

/** 审批方案（需携带 version + snapshotVersion，过期返回 409 PLAN_STALE）。
 * 审批链路含快照新鲜度校验 + 审批前仿真预验证 + stale 触发重排补偿，
 * 后端实测 30-60s，前端全局 15s 超时会必然失败——单独设置 120s（同 createRun）。 */
export async function approvePlan(
  planId: string,
  body: ApprovePlanRequest,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/approve`,
    method: 'POST',
    data: body,
    timeout: 120_000,
  });
  return res.data;
}

/** 驳回方案（V2）。同审批，超时放大到 120s。 */
export async function rejectPlanV2(
  planId: string,
  body: RejectPlanRequest,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/reject`,
    method: 'POST',
    data: body,
    timeout: 120_000,
  });
  return res.data;
}

/** 下发方案（V2）。 */
export async function dispatchPlanV2(
  planId: string,
  operator?: string,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/dispatch`,
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
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/replan`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/**
 * M03 / Task 9-10：Replan Preview（dry-run readonly，08 §5）。
 * POST /api/scheduler/replan/preview：触发 → 影响闭包 → 局部子图求解（PREVIEW-*，
 * 不落库）→ 与基线方案对比，返回计数 + 指标增量。前端「预览后确认」使用。
 */
export async function previewReplan(
  body: ReplanPreviewRequest,
): Promise<ReplanPreviewResult> {
  const res = await axiosForBackend({
    url: '/api/scheduler/replan/preview',
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
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/overrides`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/**
 * T04 / P1-8：覆盖影响预览（纯计算，不落库不重排）。
 * 返回 7 项 delta（affectedAssignments / conflictsIntroduced / lateness / travel /
 * workload / stationWait / planChurn），前端"预览后确认"使用。
 */
export async function previewOverrides(
  planId: string,
  body: PlanOverrideRequest,
): Promise<OverridePreviewResponse> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/overrides/preview`,
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
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/compare/${encodeURIComponent(otherPlanId)}`,
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

/**
 * T04 / P1-5（G5）：显式触发冲突归并（写路径；GET /conflicts 为纯读）。
 * 供"立即归并"按钮/轮询任务使用；返回归并后冲突列表与计数。
 */
export async function reconcileConflicts(): Promise<{
  ok: boolean;
  reconciledCount: number;
  conflicts: SchedulingConflict[];
}> {
  const res = await axiosForBackend({
    url: '/api/scheduler/conflicts/reconcile',
    method: 'POST',
  });
  return res.data;
}

/** 查询单个调度冲突详情（V2）。 */
export async function getConflictDetail(
  conflictId: string,
): Promise<SchedulingConflict> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${encodeURIComponent(conflictId)}`,
    method: 'GET',
  });
  return res.data;
}

/** Phase 3 / P3-T1：确认冲突（OPEN → ACKNOWLEDGED）。 */
export async function acknowledgeConflict(
  conflictId: string,
  body: { operator: string; reason: string },
): Promise<SchedulingConflict> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${encodeURIComponent(conflictId)}/acknowledge`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/** Phase 3 / P3-T1：解决冲突（→ RESOLVED；resolution 可选）。 */
export async function resolveConflict(
  conflictId: string,
  body: { operator: string; reason: string; resolution?: string },
): Promise<SchedulingConflict> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/** Phase 3 / P3-T1：抑制冲突（→ SUPPRESSED；suppressUntilMs 可选，缺省 24h）。 */
export async function suppressConflict(
  conflictId: string,
  body: { operator: string; reason: string; suppressUntilMs?: number },
): Promise<SchedulingConflict> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${encodeURIComponent(conflictId)}/suppress`,
    method: 'POST',
    data: body,
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
    url: `/api/scheduler/policy/versions/${encodeURIComponent(version)}/compare`,
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
    url: `/api/scheduler/policy/versions/${encodeURIComponent(version)}/activate`,
    method: 'POST',
    data: operator ? { operator } : {},
  });
  return res.data;
}

// ============================================================================
// Phase 4：Execution / KPI / Replay / Shadow / Activation / Preview
// ============================================================================

export async function updateExecution(
  assignmentId: string,
  body: ExecutionUpdateRequest,
): Promise<SchedulingExecution> {
  const res = await axiosForBackend({
    url: `/api/scheduler/executions/${encodeURIComponent(assignmentId)}/update`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listExecutions(params?: {
  planId?: string;
  taskId?: string;
  status?: string;
}): Promise<ExecutionListResponse> {
  const res = await axiosForBackend({
    url: '/api/scheduler/executions',
    method: 'GET',
    params,
  });
  return res.data;
}

export async function getKpi(persist = false): Promise<SchedulerKpiSnapshot> {
  const res = await axiosForBackend({
    url: '/api/scheduler/kpi',
    method: 'GET',
    params: persist ? { persist: '1' } : undefined,
  });
  return res.data;
}

export async function comparePlansV2(
  baselinePlanId: string,
  candidatePlanId: string,
): Promise<PlanCompareResult> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(baselinePlanId)}/compare/${encodeURIComponent(candidatePlanId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function previewConflictAction(
  conflictId: string,
  body?: ConflictPreviewRequest,
): Promise<ConflictPreviewResult> {
  const res = await axiosForBackend({
    url: `/api/scheduler/conflicts/${encodeURIComponent(conflictId)}/actions/preview`,
    method: 'POST',
    data: body ?? {},
  });
  return res.data;
}

export async function runPolicyReplay(
  body: PolicyReplayRequest,
): Promise<PolicyReplayRecord> {
  const res = await axiosForBackend({
    url: '/api/scheduler/policy/replay',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listPolicyReplays(): Promise<PolicyReplayRecord[]> {
  const res = await axiosForBackend({ url: '/api/scheduler/policy/replay', method: 'GET' });
  return res.data;
}

export async function enableShadowPolicy(
  version: number,
  operator?: string,
): Promise<{ ok: boolean; status: string; policyVersion: number }> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/${encodeURIComponent(version)}/shadow`,
    method: 'POST',
    data: operator ? { operator } : {},
  });
  return res.data;
}

export async function generateShadowPlan(
  version: number,
): Promise<{ shadowPlan: SchedulingPlanV2; compare: PlanCompareResult | null }> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/${encodeURIComponent(version)}/shadow/plan`,
    method: 'POST',
  });
  return res.data;
}

export async function evaluatePolicyGate(
  version: number,
  replayId?: string,
): Promise<PolicyGateEvaluation> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/${encodeURIComponent(version)}/gate`,
    method: 'POST',
    data: replayId ? { replayId } : {},
  });
  return res.data;
}

export async function activatePolicy(
  version: number,
  body: { operator: string; reason?: string; replayId?: string },
): Promise<PolicyActivationRecord> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/${encodeURIComponent(version)}/activate`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listPolicyActivations(): Promise<PolicyActivationRecord[]> {
  const res = await axiosForBackend({ url: '/api/scheduler/policy/activations', method: 'GET' });
  return res.data;
}

export async function rollbackPolicyActivation(
  activationId: string,
  body: { operator: string; reason?: string },
): Promise<PolicyActivationRecord> {
  const res = await axiosForBackend({
    url: `/api/scheduler/policy/activations/${encodeURIComponent(activationId)}/rollback`,
    method: 'POST',
    data: body,
  });
  return res.data;
}
