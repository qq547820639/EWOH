"""Canonical Event Catalog 类型锁（ADR-009 目录 / NO-04b，Python 侧锁定投影）。

权威契约：contracts/events/event-catalog.yaml（x-event-types）。
本文件为锁定投影，由 scripts/audit-event-catalog.js 门禁强制与 YAML 目录
逐项一致（70 类）；新增事件类型必须先改 catalog 再同步本列表。

零第三方依赖。
"""

EVENT_CATALOG_TYPES: tuple[str, ...] = (
    "DeviceBirth", "DeviceStateChanged", "TelemetryObserved",
    "TaskCreated", "TaskStateChanged", "TaskStepStateChanged",
    "AndonRaised", "OrderReceived", "OrderAcknowledged",
    "AssetConformanceFailed", "FleetUpgradeStarted", "FleetRollbackCompleted",
    "AuditEntryAppended", "WorldEntityUpdated", "ResourceStateChanged",
    "RunCreated", "RunSucceeded", "RunFailed",
    "PlanCreated", "PlanUpdated", "PlanApproved",
    "PlanRejected", "PlanDispatched", "AssignmentDispatched",
    "ConflictDetected", "ConflictAcknowledged", "ConflictResolved",
    "ConflictSuppressed", "ReplanCompleted", "ReplanApprovalRequired",
    "ReplanSuppressed", "ExecutionDeviation", "PolicyActivated",
    "PolicyRolledBack", "EntityIdentityMapped", "DeviceLowBattery",
    "DeviceThermalRisk", "WorkerHighLoad", "WorkerPostureRisk", "DeviceOffline",
    "DataDegraded", "DataQualityAlert", "MaintenanceConditionDetected",
    "MaintenanceConditionResolved", "QualityFindingDetected", "QualityFindingDispositioned",
    "WorkOrderCreated", "WorkOrderCompleted", "EntityDeclared",
    "EntityStateObserved", "AgentTaskProposed", "AgentDecisionRecorded",
    "AgentTaskCreated", "AgentTaskCompleted", "KnowledgeEntryCreated",
    "InferenceResultRecorded", "LearningEvaluationRecorded",
    "DeadLetterRecorded", "SimulationRunCreated", "SimulationRunCompleted",
    "LearningProposalCreated", "LearningProposalResolved",
    "ExoSessionStarted", "ExoSessionEnded",
    "OutcomeAnnotationRecorded", "ExoConfigRecorded",
    "PlanCancelled", "DataQualityConfirmed",
    "ShiftHandoverRecorded", "RetrospectiveRecorded",
)
