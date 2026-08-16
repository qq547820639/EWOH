/* 前后端共享契约 - Canonical Maintenance Condition Model（ADR-010 / NO-05a）。
 *
 * 权威契约：contracts/maintenance/maintenance.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/maintenance.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';
import { DomainContractError, normalizeSeverity } from './risk';
import { parseEnvelopeTs } from './event-envelope';

export const MAINTENANCE_CONDITION_TYPES = [
  'wear', 'calibration_due', 'fault_recurring', 'overdue_inspection',
  'battery_degradation', 'anomaly',
] as const;
export type MaintenanceConditionType = (typeof MAINTENANCE_CONDITION_TYPES)[number];

export const MAINTENANCE_LIFECYCLE = ['detected', 'acknowledged', 'work_order_created', 'resolved', 'closed'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_LIFECYCLE)[number];

const TYPE_SET: ReadonlySet<string> = new Set(MAINTENANCE_CONDITION_TYPES);
const TRANSITIONS: ReadonlySet<string> = new Set([
  'detected->acknowledged',
  'acknowledged->work_order_created',
  'work_order_created->resolved',
  'resolved->closed',
]);
const RESOLVED_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed']);

export function isMaintenanceConditionType(value: string): value is MaintenanceConditionType {
  return TYPE_SET.has(value);
}

export function isMaintenanceStatus(value: string): value is MaintenanceStatus {
  return (MAINTENANCE_LIFECYCLE as readonly string[]).includes(value);
}

export function maintenanceTransitionAllowed(from: string, to: string): boolean {
  if (!isMaintenanceStatus(from) || !isMaintenanceStatus(to)) return false;
  return TRANSITIONS.has(`${from}->${to}`);
}

/** 校验 MaintenanceCondition 记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateMaintenanceCondition(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['conditionId', 'subjectEntityId', 'conditionType', 'severity', 'status']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.conditionId !== 'string' || r.conditionId === '') return ['bad_condition_id'];
  if (typeof r.subjectEntityId !== 'string' || !isCanonicalIdentity(r.subjectEntityId)) return ['bad_subject'];
  if (!TYPE_SET.has(String(r.conditionType))) return ['unknown_condition_type'];
  if (typeof r.severity !== 'string') return ['unknown_severity'];
  try {
    normalizeSeverity(r.severity);
  } catch {
    return ['unknown_severity'];
  }
  if (!isMaintenanceStatus(String(r.status))) return ['unknown_status'];
  return [];
}

/** 逾期判定：dueAt < now 且 status ∉ {resolved, closed}；解析失败 fail-closed 不判逾期。 */
export function isMaintenanceOverdue(dueAt: string | null | undefined, status: string, now: string): boolean {
  if (dueAt == null || RESOLVED_STATUSES.has(status)) return false;
  const due = parseEnvelopeTs(dueAt);
  const nowMs = parseEnvelopeTs(now);
  if (due == null || nowMs == null) return false;
  return due < nowMs;
}

/**
 * NO-05c：维护状态 → 资源投影/资格视图（ADR-010 调度输入）。
 * ResourceProjectionService 将活跃条件（status ∉ {resolved, closed}）附着到
 * ResourceState.maintenance / WorldStateSnapshot 资源；EligibilityService 对其
 * fail-closed 拒绝派工（人审解除）。severity 为归一化 Canonical Risk 阶梯。
 */
export interface MaintenanceConditionProjection {
  conditionId: string;
  conditionType: string;
  severity: string;
  status: string;
  dueAt: string | null;
  overdue: boolean;
}
