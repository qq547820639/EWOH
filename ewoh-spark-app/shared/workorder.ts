/* 前后端共享契约 - Canonical Work Order Model（ADR-012 / NO-05e-a）。
 *
 * 权威契约：contracts/workorder/work-order.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/workorder.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';
import { DomainContractError, normalizeSeverity } from './risk';
import { parseEnvelopeTs } from './event-envelope';

export const WORK_ORDER_TYPES = [
  'maintenance', 'quality_rework', 'inspection',
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

export const WORK_ORDER_ORIGIN_KINDS = [
  'maintenance_condition', 'quality_finding',
] as const;
export type WorkOrderOriginKind = (typeof WORK_ORDER_ORIGIN_KINDS)[number];

export const WORK_ORDER_LIFECYCLE = [
  'created', 'scheduled', 'in_progress', 'completed', 'closed', 'cancelled',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_LIFECYCLE)[number];

const TYPE_SET: ReadonlySet<string> = new Set(WORK_ORDER_TYPES);
const ORIGIN_SET: ReadonlySet<string> = new Set(WORK_ORDER_ORIGIN_KINDS);
const TRANSITIONS: ReadonlySet<string> = new Set([
  'created->scheduled',
  'scheduled->in_progress',
  'in_progress->completed',
  'completed->closed',
  'created->cancelled',
  'scheduled->cancelled',
]);
const COMPLETED_STATUSES: ReadonlySet<string> = new Set(['completed', 'closed']);

export function isWorkOrderType(value: string): value is WorkOrderType {
  return TYPE_SET.has(value);
}

export function isWorkOrderStatus(value: string): value is WorkOrderStatus {
  return (WORK_ORDER_LIFECYCLE as readonly string[]).includes(value);
}

export function workOrderTransitionAllowed(from: string, to: string): boolean {
  if (!isWorkOrderStatus(from) || !isWorkOrderStatus(to)) return false;
  return TRANSITIONS.has(`${from}->${to}`);
}

function parseableIso(value: unknown): boolean {
  return typeof value === 'string' && parseEnvelopeTs(value) != null;
}

/** 校验 WorkOrder 记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateWorkOrder(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['workOrderId', 'workOrderType', 'origin', 'subjectEntityId', 'severity', 'status']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.workOrderId !== 'string' || r.workOrderId === '') return ['bad_work_order_id'];
  if (!TYPE_SET.has(String(r.workOrderType))) return ['unknown_work_order_type'];
  const origin = r.origin;
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) {
    return ['missing_origin'];
  }
  const o = origin as Record<string, unknown>;
  if (!('kind' in o) || !('id' in o)) return ['missing_origin'];
  if (!ORIGIN_SET.has(String(o.kind))) return ['unknown_origin_kind'];
  if (typeof o.id !== 'string' || o.id === '') return ['bad_origin_id'];
  if (typeof r.subjectEntityId !== 'string' || !isCanonicalIdentity(r.subjectEntityId)) return ['bad_subject'];
  if (typeof r.severity !== 'string') return ['unknown_severity'];
  try {
    normalizeSeverity(r.severity);
  } catch (err) {
    if (err instanceof DomainContractError && err.code === 'unknown_severity') return ['unknown_severity'];
    throw err;
  }
  const status = String(r.status);
  if (!isWorkOrderStatus(status)) return ['unknown_status'];
  if (r.scheduledFor != null && !parseableIso(r.scheduledFor)) return ['bad_scheduled_for'];
  if (COMPLETED_STATUSES.has(status) && r.completedAt == null) return ['completed_at_required'];
  if (r.completedAt != null && !parseableIso(r.completedAt)) return ['bad_completed_at'];
  if (status === 'cancelled') {
    if (typeof r.cancelledReason !== 'string' || r.cancelledReason === '') {
      return ['cancelled_reason_required'];
    }
  }
  return [];
}
