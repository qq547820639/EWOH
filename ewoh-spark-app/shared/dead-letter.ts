/* 前后端共享契约 - Canonical Dead Letter（ADR-024 / NO-11a，§20 Reliability）。
 *
 * 权威契约：contracts/reliability/dead-letter.schema.json +
 * dead-letter.test-vectors.json。
 * 语义与 src/edge_platform/contracts/dead_letter.py 逐项一致（共享向量约束）。
 */

export const DEAD_LETTER_REASONS = [
  'contract_violation', 'unknown_event_type', 'permanent_failure',
  'ttl_expired', 'max_attempts_exceeded',
  // 2026-09-15 仿真对抗审计补注册：坏时钟事件拒绝（cloud:ingest）与事件写库失败
  // 的死信此前 reason 不在封闭注册表 → DeadLetterService.record 抛 unknown_reason
  // 被 .catch 吞掉——"落死信人审"承诺静默失效（review:integration 实测）。
  'clock_drift_future', 'event_write_failed',
] as const;

export const DEAD_LETTER_STATUSES = ['pending', 'requeued', 'discarded'] as const;

const REASON_SET: ReadonlySet<string> = new Set(DEAD_LETTER_REASONS);
const STATUS_SET: ReadonlySet<string> = new Set(DEAD_LETTER_STATUSES);

const REQUIRED_FIELDS = [
  'letterId', 'sourceId', 'reason', 'attempts', 'status',
  'envelope', 'correlationId', 'auditTrail',
] as const;

/** 校验死信记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateDeadLetter(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.letterId !== 'string' || r.letterId === '') return ['bad_letter_id'];
  if (typeof r.sourceId !== 'string' || r.sourceId === '') return ['bad_source'];
  if (!REASON_SET.has(String(r.reason))) return ['unknown_reason'];
  const attempts = r.attempts;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    return ['bad_attempts'];
  }
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  const envelope = r.envelope;
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)
    || Object.keys(envelope).length === 0) {
    return ['envelope_required'];
  }
  if (r.status === 'discarded') {
    const reason = r.discardedReason;
    if (typeof reason !== 'string' || reason.trim() === '') return ['discard_reason_required'];
  }
  if (r.correlationId != null && typeof r.correlationId !== 'string') return ['bad_correlation'];
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}
