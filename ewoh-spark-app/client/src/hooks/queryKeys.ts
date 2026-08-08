import type { ApiNamespace } from '../api/namespaces';
import type {
  DeviceSearchQuery,
  PersonnelQuery,
  ListRunsRequest,
  ConflictsListRequest,
} from '@shared/api.interface';

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
  spatialEntities: ['spatial-entities'] as const,
  spatialHierarchy: ['spatial-hierarchy'] as const,
  worldState: ['world-state'] as const,
  overview: ['overview'] as const,
  events: (status?: string) => ['events', status ?? 'all'] as const,
  devices: (query?: DeviceSearchQuery) => ['devices', query ?? {}] as const,
  deviceBindings: (deviceId?: string) => ['device-bindings', deviceId ?? 'none'] as const,
  replaySnapshots: ['world-replay'] as const,
  schedulerPlans: (status?: string) => ['scheduler-plans', status ?? 'all'] as const,
  /** 当前活跃的调度方案列表（V2），由 createRun 结果 + SSE 事件流写入缓存维护。 */
  schedulerActivePlans: ['scheduler-active-plans'] as const,
  /** 单个方案详情（V2）。 */
  schedulerPlan: (planId: string) => ['scheduler-plan', planId] as const,
  /** 单个调度运行记录（V2）。 */
  schedulerRun: (runId: string) => ['scheduler-run', runId] as const,
  /** 调度运行历史分页列表 + 活跃方案（V2）。 */
  schedulerRuns: (filters?: ListRunsRequest) => ['scheduler', 'runs', filters ?? {}] as const,
  /** map 与调度共享的当前世界状态快照（V2）。 */
  schedulerSnapshot: ['scheduler', 'snapshot'] as const,
  /** 单个任务的候选资源（V2，后端资格判定 + 路径可行性计算）。 */
  schedulerTaskCandidates: (taskId: string) => ['scheduler-task-candidates', taskId] as const,
  /** 统一调度冲突列表（V2 冲突中心 / 命令图冲突面板）。 */
  schedulerConflicts: (filters?: ConflictsListRequest) => ['scheduler', 'conflicts', filters ?? {}] as const,
  /** 单个调度冲突详情（V2）。 */
  schedulerConflict: (conflictId: string) => ['scheduler-conflict', conflictId] as const,
  /** P1-CMAP-002：统一资源状态权威投影（ResourceProjection SSOT）。 */
  schedulerResourceState: ['scheduler-resource-state'] as const,
  /** 当前生效调度策略 + 配置（Task 6）。 */
  schedulerPolicy: ['scheduler-policy'] as const,
  /** 全部策略版本列表（Task 6）。 */
  schedulerPolicyVersions: ['scheduler-policy-versions'] as const,
  /** 候选策略版本 vs 生效版本的 shadow 对比（Task 6）。 */
  schedulerPolicyComparison: (version: number) => ['scheduler-policy', 'compare', version] as const,
  commandCenter: ['command-center'] as const,
  digitalWorld: ['digital-world'] as const,
  personnel: (query?: PersonnelQuery) => ['personnel', query ?? {}] as const,
  alerts: ['alerts'] as const,
  organizationTree: ['organization-tree'] as const,
  organizations: ['organizations'] as const,
  models: ['models'] as const,
  dataAssets: ['data-assets'] as const,
  systemConfigs: ['system-configs'] as const,
  aiSuggestions: ['ai-suggestions'] as const,
  aiPlans: ['ai-plans'] as const,
  aiConfigStatus: ['ai-config-status'] as const,
  environmentSummary: ['environment-summary'] as const,
  mobileWorkbench: (personId: string) => ['mobile-workbench', personId] as const,
  mobileOrder: (orderId: string) => ['mobile-order', orderId] as const,
  scaleTemplates: ['scale-templates'] as const,
  scaleProfiles: ['scale-profiles'] as const,
  scaleAssets: ['scale-assets'] as const,
  scaleCompatibility: ['scale-compatibility'] as const,
  scaleDashboard: ['scale-dashboard'] as const,
  scaleDifferences: ['scale-differences'] as const,
  scaleFleetStatus: ['scale-fleet-status'] as const,
  workflowInstances: ['workflow-instances'] as const,
  operationsSummary: ['operations-summary'] as const,
  operationsAssets: ['operations-assets'] as const,
  operationsTasks: ['operations-tasks'] as const,
  operationsTools: ['operations-tools'] as const,
  operationsWorkCenters: ['operations-work-centers'] as const,
  operationsStandardHours: ['operations-standard-hours'] as const,
  operationsEfficiency: ['operations-efficiency'] as const,
  operationsEfficiencySummary: ['operations-efficiency-summary'] as const,
  roleWorkbench: (role: string) => ['role-workbench', role] as const,
  parameters: ['parameters'] as const,
  parameterSummary: ['parameter-summary'] as const,
  aasAssets: ['aas-assets'] as const,
  aasSemantics: (assetId: string) => ['aas-assets', assetId, 'semantics'] as const,
  traces: ['observability-traces'] as const,
  workOverview: ['work-overview'] as const,
  workGraph: ['work-graph'] as const,
  workItems: (filters?: Record<string, unknown>) => ['work-items', filters ?? {}] as const,
  workEvidence: (filters?: Record<string, unknown>) => ['work-evidence', filters ?? {}] as const,
  workAgents: ['work-agents'] as const,
  workGates: ['work-gates'] as const,
  workGateHistory: (gateId: string) => ['work-gate-history', gateId] as const,
  workBlockedReason: (itemId: string) => ['work-blocked-reason', itemId] as const,
  workRisks: ['work-risks'] as const,
  workResources: ['work-resources'] as const,
  workHandoffs: ['work-handoffs'] as const,
  workCatalog: ['work-catalog'] as const,
  workGitSync: ['work-git-sync'] as const,
  workSiteReadiness: ['work-site-readiness'] as const,
};
