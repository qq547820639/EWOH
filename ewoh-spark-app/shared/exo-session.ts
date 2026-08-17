/* 前后端共享契约 - Canonical Exo Session（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 权威契约：contracts/exo/exo-session.schema.json + exo-session.test-vectors.json。
 * 语义与 src/edge_platform/contracts/exo_session.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';

export const EXO_SESSION_STATUSES = ['active', 'ended', 'aborted'] as const;
export type ExoSessionStatus = (typeof EXO_SESSION_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(EXO_SESSION_STATUSES);

const REQUIRED_FIELDS = ['sessionId', 'exoId', 'personId', 'status', 'startedAt', 'auditTrail'] as const;

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

function isoTs(value: unknown): number {
  return Date.parse(String(value));
}

/** 校验外骨骼会话记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateExoSession(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.sessionId !== 'string' || !r.sessionId.startsWith('exo-session:')) {
    return ['bad_session_id'];
  }
  const exoId = r.exoId;
  // SH-001：与 Python is_canonical_identity 对齐（value 限 [A-Za-z0-9._~@-]），
  // 弃用宽松 regex（不限 value 字符集，TS 放行 Python 拒绝的 ID）。
  if (typeof exoId !== 'string' || !isCanonicalIdentity(exoId) || !exoId.startsWith('device:')) {
    return ['bad_exo_identity'];
  }
  const personId = r.personId;
  if (typeof personId !== 'string' || !isCanonicalIdentity(personId) || !personId.startsWith('person:')) {
    return ['bad_person_identity'];
  }
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (!isIso(r.startedAt)) return ['bad_start_time'];
  const actualEnd = r.actualEndAt;
  const status = String(r.status);
  if (status === 'ended' || status === 'aborted') {
    if (!isIso(actualEnd)) return ['actual_end_required'];
    if (isoTs(actualEnd) < isoTs(r.startedAt)) return ['bad_time_order'];
    if (typeof r.endedBy !== 'string' || r.endedBy.trim() === '') return ['ended_by_required'];
  } else if (actualEnd !== undefined) {
    return ['actual_end_not_allowed'];
  }
  if (r.expectedEndAt !== undefined && !isIso(r.expectedEndAt)) return ['bad_expected_end'];
  if (r.operatorId !== undefined && (typeof r.operatorId !== 'string' || r.operatorId === '')) {
    return ['bad_operator'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

/** ADR-032 状态机：active→{ended, aborted}；终态不可复开。 */
export function exoSessionTransitionAllowed(fromStatus: string, toStatus: string): boolean {
  return fromStatus === 'active' && (toStatus === 'ended' || toStatus === 'aborted');
}
