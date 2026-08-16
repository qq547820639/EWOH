/* 前后端共享契约 - Canonical Event Catalog 类型锁（ADR-009 目录 / NO-04b）。
 *
 * 权威契约：contracts/events/event-catalog.yaml（x-event-types）。
 * 本文件为锁定投影，由 scripts/audit-event-catalog.js 门禁强制与 YAML 目录
 * 逐项一致（64 类）；新增事件类型必须先改 catalog 再同步本列表。
 */

export const EVENT_CATALOG_TYPES = [
  'DeviceBirth', 'DeviceStateChanged', 'TelemetryObserved',
  'TaskCreated', 'TaskStateChanged', 'TaskStepStateChanged',
  'AndonRaised', 'OrderReceived', 'OrderAcknowledged',
  'AssetConformanceFailed', 'FleetUpgradeStarted', 'FleetRollbackCompleted',
  'AuditEntryAppended', 'WorldEntityUpdated', 'ResourceStateChanged',
  'RunCreated', 'RunSucceeded', 'RunFailed',
  'PlanCreated', 'PlanUpdated', 'PlanApproved',
  'PlanRejected', 'PlanDispatched', 'AssignmentDispatched',
  'ConflictDetected', 'ConflictAcknowledged', 'ConflictResolved',
  'ConflictSuppressed', 'ReplanCompleted', 'ReplanApprovalRequired',
  'ReplanSuppressed', 'ExecutionDeviation', 'PolicyActivated',
  'PolicyRolledBack', 'EntityIdentityMapped', 'DeviceLowBattery',
  'WorkerHighLoad', 'WorkerPostureRisk', 'DeviceOffline',
  'DataDegraded', 'DataQualityAlert', 'MaintenanceConditionDetected',
  'MaintenanceConditionResolved', 'QualityFindingDetected', 'QualityFindingDispositioned',
  'WorkOrderCreated', 'WorkOrderCompleted', 'EntityDeclared',
  'EntityStateObserved', 'AgentTaskProposed', 'AgentDecisionRecorded',
  'AgentTaskCreated', 'AgentTaskCompleted', 'KnowledgeEntryCreated',
  'InferenceResultRecorded', 'LearningEvaluationRecorded',
  'DeadLetterRecorded', 'SimulationRunCreated', 'SimulationRunCompleted',
  'LearningProposalCreated', 'LearningProposalResolved',
  'ExoSessionStarted', 'ExoSessionEnded',
  'OutcomeAnnotationRecorded', 'ExoConfigRecorded',
] as const;

export type CatalogEventType = (typeof EVENT_CATALOG_TYPES)[number];

const CATALOG_TYPE_SET: ReadonlySet<string> = new Set(EVENT_CATALOG_TYPES);

/** 类型是否属于 Canonical Event Catalog（未知类型 fail-closed 拒绝上行）。 */
export function isCatalogEventType(type: unknown): type is CatalogEventType {
  return typeof type === 'string' && CATALOG_TYPE_SET.has(type);
}
