import type { ApiNamespace } from '../api/namespaces';
import type {
  DeviceSearchQuery,
  PersonnelQuery,
  ListRunsRequest,
  ConflictsListRequest,
} from '@shared/api.interface';

/**
 * CLI-715：全局缓存键按当前登录组织分片。原 spatialEntities/worldState/
 * overview/replaySnapshots 为无 org 维度的常量键，多租户切换账号后可能
 * 命中上一租户的缓存。改为 getter——每次访问读取当前 auth user 的 orgId
 * 拼入键首段，调用点（queryKeys.xxx）无需改动。
 *
 * 注意：这里直接读 sessionStorage（与 lib/auth.ts 的 AUTH_USER_KEY 同键），
 * 不 import lib/auth——auth → api/auth → lib/http 的链条携带 Vite 专属的
 * import.meta 语法，会把整个 jest 环境拖进非必要 的 transform 失败面。
 */
export function currentOrgScope(): string {
  try {
    const raw =
      typeof window !== 'undefined'
        ? window.sessionStorage.getItem('ewoh_auth_user')
        : null;
    if (raw) {
      const parsed = JSON.parse(raw) as { orgId?: string };
      if (parsed?.orgId) return parsed.orgId;
    }
  } catch {
    // 解析失败视作无组织上下文。
  }
  return 'no-org';
}

export function tenantQueryKey(...segments: readonly unknown[]) {
  return [currentOrgScope(), ...segments] as const;
}

function schedulerKey(...segments: readonly unknown[]) {
  return ['scheduler', currentOrgScope(), ...segments] as const;
}

export const queryKeys = {
  org: (orgId: string) => ['org', orgId] as const,
  scope: (orgId: string) => ['org', orgId, 'scope'] as const,
  center: (orgId: string, center: string) => ['org', orgId, 'center', center] as const,
  list: (orgId: string, resource: ApiNamespace, filters?: Record<string, unknown>) =>
    ['org', orgId, resource, 'list', filters ?? {}] as const,
  detail: (orgId: string, resource: ApiNamespace, id: string) =>
    ['org', orgId, resource, 'detail', id] as const,
  world: (orgId: string) => ['org', orgId, 'world'] as const,
  audit: (orgId: string, filters?: Record<string, unknown>) =>
    ['org', orgId, 'audit', filters ?? {}] as const,
  get spatialEntities() {
    return ['spatial-entities', currentOrgScope()] as const;
  },
  get spatialHierarchy() { return tenantQueryKey('spatial-hierarchy'); },
  get worldState() {
    return ['world-state', currentOrgScope()] as const;
  },
  get overview() {
    return ['overview', currentOrgScope()] as const;
  },
  get factoryOperationsOverview() {
    return ['factory-operations', currentOrgScope(), 'overview'] as const;
  },
  factoryOperationsEvents: (page: number, pageSize: number) =>
    ['factory-operations', currentOrgScope(), 'events', page, pageSize] as const,
  get factoryOperationsPlans() {
    return ['factory-operations', currentOrgScope(), 'plans'] as const;
  },
  events: (status?: string) => tenantQueryKey('events', status ?? 'all'),
  devices: (query?: DeviceSearchQuery) => tenantQueryKey('devices', query ?? {}),
  deviceBindings: (deviceId?: string) => tenantQueryKey('device-bindings', deviceId ?? 'none'),
  get replaySnapshots() {
    return ['world-replay', currentOrgScope()] as const;
  },
  schedulerPlans: (status?: string) => ['scheduler-plans', currentOrgScope(), status ?? 'all'] as const,
  /** 当前活跃的调度方案列表（V2），由 createRun 结果 + SSE 事件流写入缓存维护。 */
  get schedulerActivePlans() {
    return ['scheduler-active-plans', currentOrgScope()] as const;
  },
  /** 单个方案详情（V2）。 */
  get schedulerPlanPrefix() { return ['scheduler-plan', currentOrgScope()] as const; },
  schedulerPlan: (planId: string) => ['scheduler-plan', currentOrgScope(), planId] as const,
  /** 单个调度运行记录（V2）。 */
  get schedulerRunPrefix() { return ['scheduler-run', currentOrgScope()] as const; },
  schedulerRun: (runId: string) => ['scheduler-run', currentOrgScope(), runId] as const,
  /** 调度运行历史分页列表 + 活跃方案（V2）。 */
  schedulerRuns: (filters?: ListRunsRequest) =>
    filters ? schedulerKey('runs', filters) : schedulerKey('runs'),
  /** map 与调度共享的当前世界状态快照（V2）。 */
  get schedulerSnapshot() {
    return schedulerKey('snapshot');
  },
  /** P1-D：统一调度上下文（GET /api/scheduler/context，版本边界 + dataQuality）。 */
  get schedulerContext() {
    return ['scheduler-context', currentOrgScope()] as const;
  },
  /** 单个任务的候选资源（V2，后端资格判定 + 路径可行性计算）。 */
  schedulerTaskCandidates: (taskId: string) =>
    ['scheduler-task-candidates', currentOrgScope(), taskId] as const,
  /** 统一调度冲突列表（V2 冲突中心 / 命令图冲突面板）。 */
  schedulerConflicts: (filters?: ConflictsListRequest) =>
    filters ? schedulerKey('conflicts', filters) : schedulerKey('conflicts'),
  /** 单个调度冲突详情（V2）。 */
  schedulerConflict: (conflictId: string) => ['scheduler-conflict', currentOrgScope(), conflictId] as const,
  /** Phase 4 执行反馈：方案执行记录列表（planned vs actual，决策驾驶舱消费）。 */
  schedulerExecutions: (planId?: string) => schedulerKey('executions', planId ?? 'all'),
  /**
   * 执行记录查询的**前缀键**（不含尾部过滤段）。React Query 失效靠前缀匹配，
   * 更长的键匹配不到更短的查询键：回执提交后要同时命中按方案过滤
   * （schedulerExecutions(planId)）、现场按人收敛（'field-my-work'）与全量列表
   * （schedulerExecutions()），必须用这三者的公共前缀失效。
   */
  get schedulerExecutionsPrefix() { return schedulerKey('executions'); },
  /** P1-CMAP-002：统一资源状态权威投影（ResourceProjection SSOT）。 */
  get schedulerResourceState() {
    return ['scheduler-resource-state', currentOrgScope()] as const;
  },
  /** 当前生效调度策略 + 配置（Task 6）。 */
  get schedulerPolicy() {
    return ['scheduler-policy', currentOrgScope()] as const;
  },
  /** 全部策略版本列表（Task 6）。 */
  get schedulerPolicyVersions() {
    return ['scheduler-policy-versions', currentOrgScope()] as const;
  },
  /** 候选策略版本 vs 生效版本的 shadow 对比（Task 6）。 */
  schedulerPolicyComparison: (version: number) =>
    ['scheduler-policy', currentOrgScope(), 'compare', version] as const,
  get approvals() { return tenantQueryKey('approvals'); },
  get notifications() { return tenantQueryKey('notifications'); },
  /**
   * NO-53a：班次工作台只取"未处置"提醒（GET /api/notifications?status=pending）。
   * 必须与上面的全量列表分键——同一 queryKey 配不同 queryFn 会让两个页面互相
   * 命中对方的缓存（班组长会看到已处置的提醒，或审批台只剩 pending）。
   */
  get notificationsPending() { return tenantQueryKey('notifications', 'pending'); },
  get commandCenter() { return tenantQueryKey('command-center'); },
  get commandCenterOverview() { return tenantQueryKey('command-center', 'overview'); },
  get commandCenterEvents() { return tenantQueryKey('command-center', 'events'); },
  get digitalWorld() { return tenantQueryKey('digital-world'); },
  personnel: (query?: PersonnelQuery) => tenantQueryKey('personnel', query ?? {}),
  get alerts() { return tenantQueryKey('alerts'); },
  get organizationTree() { return tenantQueryKey('organization-tree'); },
  get organizations() { return tenantQueryKey('organizations'); },
  get models() { return tenantQueryKey('models'); },
  get dataAssets() { return tenantQueryKey('data-assets'); },
  get systemConfigs() { return tenantQueryKey('system-configs'); },
  get aiSuggestions() { return tenantQueryKey('ai-suggestions'); },
  get aiPlans() { return tenantQueryKey('ai-plans'); },
  get aiConfigStatus() { return tenantQueryKey('ai-config-status'); },
  get environmentSummary() { return tenantQueryKey('environment-summary'); },
  mobileWorkbench: (personId: string) => tenantQueryKey('mobile-workbench', personId),
  mobileOrder: (orderId: string) => tenantQueryKey('mobile-order', orderId),
  get scaleTemplates() { return tenantQueryKey('scale-templates'); },
  get scaleProfiles() { return tenantQueryKey('scale-profiles'); },
  get scaleAssets() { return tenantQueryKey('scale-assets'); },
  get scaleCompatibility() { return tenantQueryKey('scale-compatibility'); },
  get scaleDashboard() { return tenantQueryKey('scale-dashboard'); },
  get scaleDifferences() { return tenantQueryKey('scale-differences'); },
  get scaleFleetStatus() { return tenantQueryKey('scale-fleet-status'); },
  get workflowInstances() { return tenantQueryKey('workflow-instances'); },
  get operationsSummary() { return tenantQueryKey('operations-summary'); },
  get operationsAssets() { return tenantQueryKey('operations-assets'); },
  get operationsTasks() { return tenantQueryKey('operations-tasks'); },
  get operationsTools() { return tenantQueryKey('operations-tools'); },
  get operationsWorkCenters() { return tenantQueryKey('operations-work-centers'); },
  get operationsStandardHours() { return tenantQueryKey('operations-standard-hours'); },
  get operationsEfficiency() { return tenantQueryKey('operations-efficiency'); },
  get operationsEfficiencySummary() { return tenantQueryKey('operations-efficiency-summary'); },
  roleWorkbench: (role: string) => tenantQueryKey('role-workbench', role),
  get parameters() { return tenantQueryKey('parameters'); },
  get parameterSummary() { return tenantQueryKey('parameter-summary'); },
  get aasAssets() { return tenantQueryKey('aas-assets'); },
  aasSemantics: (assetId: string) => tenantQueryKey('aas-assets', assetId, 'semantics'),
  get traces() { return tenantQueryKey('observability-traces'); },
  get workOverview() { return tenantQueryKey('work-overview'); },
  get workGraph() { return tenantQueryKey('work-graph'); },
  workItems: (filters?: Record<string, unknown>) => tenantQueryKey('work-items', filters ?? {}),
  workEvidence: (filters?: Record<string, unknown>) => tenantQueryKey('work-evidence', filters ?? {}),
  get workAgents() { return tenantQueryKey('work-agents'); },
  get workGates() { return tenantQueryKey('work-gates'); },
  workGateHistory: (gateId: string) => tenantQueryKey('work-gate-history', gateId),
  workBlockedReason: (itemId: string) => tenantQueryKey('work-blocked-reason', itemId),
  get workRisks() { return tenantQueryKey('work-risks'); },
  get workResources() { return tenantQueryKey('work-resources'); },
  get workHandoffs() { return tenantQueryKey('work-handoffs'); },
  get workCatalog() { return tenantQueryKey('work-catalog'); },
  get workGitSync() { return tenantQueryKey('work-git-sync'); },
  get workSiteReadiness() { return tenantQueryKey('work-site-readiness'); },
  simulationRuns: (filters?: { kind?: string; status?: string }) =>
    tenantQueryKey('simulation', 'runs', filters ?? {}),
  /** NO-13q / ADR-066：决策历史跨 kind 检索（GET /api/scheduler/decision-history）。 */
  get decisions() { return tenantQueryKey('decision-history'); },
  // ── DR-2/DR-3/DR-4（2026-09-11）：班次/复盘/数据质量确认 ──────────────
  /** 当前班次 + 下一班（DR-2 班次工作台）。 */
  get shiftCurrent() { return tenantQueryKey('shift-current'); },
  /** 班次定义（active 过滤在 queryFn 内）。 */
  get shiftDefinitions() { return tenantQueryKey('shift-definitions'); },
  /** 交接班记录（最近 N 条）。 */
  get shiftHandovers() { return tenantQueryKey('shift-handovers'); },
  /** 数据质量确认状态（按事件 id 集合分键，避免交叉污染）。 */
  dataQualityConfirmations: (eventIds: readonly string[]) =>
    tenantQueryKey('data-quality-confirmations', [...eventIds].sort()),
  /** 复盘/运行记忆列表（DR-3）。 */
  retrospectives: (filters?: { scope?: string; status?: string }) =>
    tenantQueryKey('retrospectives', filters ?? {}),
  /** 单条复盘详情。 */
  retrospective: (retrospectiveId: string) =>
    tenantQueryKey('retrospectives', 'detail', retrospectiveId),
};
