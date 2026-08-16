/* 前后端共享契约 - Canonical Learning Evaluation（ADR-021 / NO-09a，Phase 12）。
 *
 * 权威契约：contracts/learning/learning-evaluation.schema.json +
 * learning-evaluation.test-vectors.json。
 * 语义与 src/edge_platform/contracts/learning_evaluation.py 逐项一致（共享向量约束）。
 */

import { parseEnvelopeTs } from './event-envelope';

export const LEARNING_METRIC_KEYS = [
  'recommendationAcceptanceRate', 'planSuccessRate', 'taskDelayP95Ms',
  'riskOutcomeRate', 'humanOverrideRate', 'modelAccuracy', 'schedulerQualityRate',
] as const;

export const LEARNING_EVALUATION_TYPES = ['periodic', 'on_demand'] as const;

export const LEARNING_ENGINE_VERSION = '1.0.0';

const METRIC_SET: ReadonlySet<string> = new Set(LEARNING_METRIC_KEYS);
const TYPE_SET: ReadonlySet<string> = new Set(LEARNING_EVALUATION_TYPES);

const REQUIRED_FIELDS = [
  'evalId', 'orgId', 'evaluationType', 'periodStart', 'periodEnd',
  'engineVersion', 'metrics', 'basis', 'auditTrail',
] as const;

export type LearningMetricValue = number | null;

/** 校验学习评估快照；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateLearningEvaluation(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.evalId !== 'string' || r.evalId === '') return ['bad_eval_id'];
  if (typeof r.orgId !== 'string' || r.orgId === '') return ['bad_org_id'];
  if (!TYPE_SET.has(String(r.evaluationType))) return ['unknown_evaluation_type'];
  const start = parseEnvelopeTs(String(r.periodStart));
  if (start == null) return ['bad_period'];
  const end = parseEnvelopeTs(String(r.periodEnd));
  if (end == null || end < start) return ['bad_period'];
  if (typeof r.engineVersion !== 'string' || r.engineVersion === '') return ['bad_engine_version'];
  const metrics = r.metrics;
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
    return ['bad_metrics'];
  }
  const m = metrics as Record<string, unknown>;
  for (const key of LEARNING_METRIC_KEYS) {
    if (!(key in m)) return ['metric_missing'];
  }
  for (const [key, value] of Object.entries(m)) {
    if (!METRIC_SET.has(key)) return ['unknown_metric'];
    if (value != null && (typeof value !== 'number' || Number.isNaN(value))) {
      return ['bad_metric_value'];
    }
  }
  const basis = r.basis;
  if (!Array.isArray(basis) || basis.length === 0) return ['basis_required'];
  if (basis.some((item) => typeof item !== 'string' || item.trim() === '')) return ['bad_basis'];
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}
