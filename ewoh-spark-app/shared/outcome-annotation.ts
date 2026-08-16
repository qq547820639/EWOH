/* 前后端共享契约 - Canonical Outcome Annotation（ADR-034 / §10 Level 7 + §12）。
 *
 * 权威契约：contracts/learning/outcome-annotation.schema.json +
 * outcome-annotation.test-vectors.json。
 * 语义与 src/edge_platform/contracts/outcome_annotation.py 逐项一致（共享向量约束）。
 */

export const OUTCOME_TARGET_TYPES = ['plan', 'decision', 'proposal', 'agent_command'] as const;
export const OUTCOME_KINDS = ['success', 'partial_success', 'failure', 'invalid'] as const;

const TARGET_SET: ReadonlySet<string> = new Set(OUTCOME_TARGET_TYPES);
const KIND_SET: ReadonlySet<string> = new Set(OUTCOME_KINDS);

const REQUIRED_FIELDS = [
  'annotationId', 'targetType', 'targetId', 'outcomeKind', 'judgedBy', 'judgedAt', 'auditTrail',
] as const;

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

/** 校验结果标注记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateOutcomeAnnotation(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.annotationId !== 'string' || r.annotationId.trim() === '') return ['bad_annotation_id'];
  if (!TARGET_SET.has(String(r.targetType))) return ['unknown_target_type'];
  if (typeof r.targetId !== 'string' || r.targetId.trim() === '') return ['bad_target_id'];
  if (!KIND_SET.has(String(r.outcomeKind))) return ['unknown_outcome_kind'];
  if (typeof r.judgedBy !== 'string' || r.judgedBy.trim() === '') return ['judger_required'];
  if (!isIso(r.judgedAt)) return ['bad_judged_at'];
  const measured = r.measured;
  if (measured !== undefined) {
    if (measured == null || typeof measured !== 'object' || Array.isArray(measured)) {
      return ['bad_measured'];
    }
    for (const value of Object.values(measured as Record<string, unknown>)) {
      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return ['bad_measured'];
      }
    }
  }
  if (r.comment !== undefined && typeof r.comment !== 'string') return ['bad_comment'];
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}
