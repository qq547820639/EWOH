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

/**
 * NO-62c：方案过期诊断（GET /api/scheduler/plans/:planId/staleness）。
 *
 * 与审批 409 使用同一诊断实现：页面可以在**点审批之前**回答
 * "这个方案还能批吗、如果不能是变了什么"，而不是靠"点一下看会不会报错"探测。
 */
export async function getPlanStaleness(planId: string) {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/staleness`,
    method: 'GET',
    timeout: 60_000,
  });
  return res.data as {
    planId: string;
    status: string;
    version: number;
    snapshotVersion: string;
    stale: boolean;
    staleness: {
      snapshotVersion: string;
      snapshotFound: boolean;
      stale: boolean;
      changes: Array<{
        kind: 'entity_version' | 'reservation';
        entityKey: string;
        entityType: string;
        entityId: string;
        change: 'added' | 'removed' | 'changed';
        selfInflicted: boolean;
        label: string;
      }>;
      externalChangeCount?: number;
      selfInflictedCount?: number;
      summary: string;
      checkedAt: string;
    };
    replanAvailable: boolean;
    checkedAt: string;
  };
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
/**
 * DR-5 方案取消/回滚：受控部分回退（未开始 assignment 取消 + 预占释放 +
 * 任务回退 pending_dispatch；已开始的不可回退项在响应 cancel 摘要中如实回报）。
 */
export async function cancelPlanV2(
  planId: string,
  reason: string,
): Promise<SchedulingPlanV2> {
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/cancel`,
    method: 'POST',
    data: { reason },
    timeout: 120_000,
  });
  return res.data;
}

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

/**
 * 分波次派工的结果摘要（服务端 additve 字段）。
 *
 * `remainingAssignments > 0` 即"部分执行"：此时计划**刻意**保持 `approved`
 * （`dispatched` 在契约中是终态，语义为"全部转任务"）。UI 必须显式呈现剩余，
 * 不能只看 planId 就认为方案已全部下发。
 */
export interface DispatchWaveSummary {
  planStatus: string;
  dispatchedAssignmentIds: string[];
  remainingAssignmentIds: string[];
  remainingAssignments: number;
  dispatchedAssignments: number;
}

export type DispatchPlanResult = SchedulingPlanV2 & { dispatch?: DispatchWaveSummary };

/**
 * 下发方案（V2），支持**分波次 / 部分执行**。
 *
 * `options.assignmentIds` 省略 → 下发全部待派工 assignment（原有行为）；
 * 提供 → 只下发这一波（波内全有或全无，服务端强制）。
 */
export async function dispatchPlanV2(
  planId: string,
  operator?: string,
  options?: { assignmentIds?: string[] },
): Promise<DispatchPlanResult> {
  const data: Record<string, unknown> = {};
  if (operator) data.operator = operator;
  if (options?.assignmentIds?.length) data.assignmentIds = options.assignmentIds;
  const res = await axiosForBackend({
    url: `/api/scheduler/plans/${encodeURIComponent(planId)}/dispatch`,
    method: 'POST',
    data,
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
/**
 * 更新任务能力要求（NO-16a：能力模型的唯一人工写入口）。
 * 未登记/当前无法匹配的能力名允许写入，但返回 warnings 显式提示。
 */
/**
 * 发起"放宽高风险能力要求"的审批（NO-20a）。
 *
 * 语义：放宽高风险能力（crane/exo-lift/interact.assist）属执行边界变更，调度员
 * 不得单独决定；本函数只**发起**审批，获批后由调用方携带 approvalId 重新提交变更。
 * 角色由服务端按 entityType 映射（不允许客户端指定审批图）。
 */
export async function requestCapabilityRelaxationApproval(params: {
  taskId: string;
  subject: {
    objectType: string;
    objectId: string;
    title: string;
    summary: string;
    metrics: Record<string, string>;
  };
}): Promise<{
  id: string;
  status: string;
  /** NO-22a：通过时间（新建时为 undefined；通过后才会有）。 */
  approvedAt?: string;
  steps?: Array<{ id: string; role: string; status: string }>;
}> {
  const res = await axiosForBackend({
    url: '/api/approvals',
    method: 'POST',
    data: {
      entityType: 'task_capability_change',
      entityId: params.taskId,
      roles: ['safety_admin'],
      subject: params.subject,
    },
  });
  return res.data;
}

/** 读取审批状态（用于"检查审批状态并重试"）。 */
export async function getApprovalStatus(
  approvalId: string,
): Promise<{
  id: string;
  status: string;
  /** NO-22a：通过时间（时效展示；未通过时为 undefined）。 */
  approvedAt?: string;
  /** 对象描述符快照（含指纹 metrics）——批量恢复据此核对"审批覆盖的设备名单"。 */
  subject?: {
    objectType?: string;
    objectId?: string;
    title?: string;
    summary?: string;
    metrics?: Record<string, string>;
  };
  steps?: Array<{ id: string; role: string; status: string }>;
}> {
  const res = await axiosForBackend({
    url: `/api/approvals/${encodeURIComponent(approvalId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function updateTaskRequirements(
  taskId: string,
  body: { requiredDeviceCapabilities?: string[]; requiredStationCapabilities?: string[] },
): Promise<{
  taskId: string;
  requiredDeviceCapabilities: string[];
  requiredStationCapabilities: string[];
  warnings: string[];
}> {
  const res = await axiosForBackend({
    url: `/api/tasks/${encodeURIComponent(taskId)}/requirements`,
    method: 'PATCH',
    data: body,
  });
  return res.data;
}

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
  /** 现场作业台：只看分配给某人的执行记录（服务端过滤，保持 org 作用域）。 */
  personId?: string;
}): Promise<ExecutionListResponse> {
  const res = await axiosForBackend({
    url: '/api/scheduler/executions',
    method: 'GET',
    params,
  });
  return res.data;
}

/**
 * 现场作业台只读投影：只返回**当前账号绑定的业务人员**的工作。
 *
 * 刻意不接受 personId 参数——范围由服务端从签名令牌推导。工人没有
 * `GET /api/scheduler/executions`（全厂执行台账）的读权限。
 */
export async function getMyFieldWork(): Promise<{
  personId: string;
  /** 绑定人员姓名（服务端回填；查不到为 null，UI 显示"未知"）。 */
  personName?: string | null;
  executions: ExecutionListResponse['executions'];
  total: number;
}> {
  const res = await axiosForBackend({ url: '/api/scheduler/field/my-work', method: 'GET' });
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
  body: {
    operator: string;
    reason?: string;
    replayId?: string;
    /**
     * Gate 因缺数据跳过检查时的显式人工确认。服务端不接受调用方自带的
     * gateResult —— Gate 结论始终由服务端现场评估。
     */
    acknowledgeInsufficientEvidence?: boolean;
  },
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

/** NO-89a：门禁指标历史序列（最近的在前；趋势可见，漂移早发现）。 */
export interface KpiHistoryEntry {
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  kpi: {
    onTimeRate: number | null;
    latenessP95Ms: number | null;
    periodStart: string;
    periodEnd: string;
  };
}

export async function getKpiHistory(limit = 12): Promise<KpiHistoryEntry[]> {
  const res = await axiosForBackend({
    url: `/api/scheduler/kpi/history?limit=${encodeURIComponent(String(limit))}`,
    method: 'GET',
  });
  return res.data;
}
