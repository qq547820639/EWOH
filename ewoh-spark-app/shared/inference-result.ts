/* 前后端共享契约 - Canonical Inference Result Model（ADR-013 / NO-08a）。
 *
 * 权威契约：contracts/intelligence/inference-result.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/inference_result.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';

export const INFERENCE_LEVELS = [
  'L1_deterministic_rules', 'L2_statistical_ml', 'L3_optimization',
  'L4_industrial_reasoning', 'L5_agentic_workflow',
  'L6_simulation_digital_twin', 'L7_learning_loop',
] as const;
export type InferenceLevel = (typeof INFERENCE_LEVELS)[number];

export const OOD_REASONS = [
  'data_quality', 'low_confidence', 'ambiguous', 'firmware_unverified',
  'out_of_distribution', 'sensor_channel_missing',
] as const;
export type OodReason = (typeof OOD_REASONS)[number];

export const INFERENCE_DATA_QUALITIES = ['good', 'degraded', 'invalid'] as const;
export type InferenceDataQuality = (typeof INFERENCE_DATA_QUALITIES)[number];

const LEVEL_SET: ReadonlySet<string> = new Set(INFERENCE_LEVELS);
const OOD_SET: ReadonlySet<string> = new Set(OOD_REASONS);
const QUALITY_SET: ReadonlySet<string> = new Set(INFERENCE_DATA_QUALITIES);

/** 校验 InferenceResult 记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateInferenceResult(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of [
    'inferenceId', 'subjectId', 'level', 'modelId', 'modelVersion',
    'inputVersion', 'label', 'confidence', 'oodIndicator', 'dataQuality', 'evidence',
  ]) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.inferenceId !== 'string' || r.inferenceId === '') return ['bad_inference_id'];
  if (typeof r.subjectId !== 'string' || !isCanonicalIdentity(r.subjectId)) return ['bad_subject'];
  if (!LEVEL_SET.has(String(r.level))) return ['unknown_level'];
  for (const key of ['modelId', 'modelVersion', 'inputVersion']) {
    if (typeof r[key] !== 'string' || r[key] === '') return [`bad_${key}`];
  }
  if (typeof r.label !== 'string' || r.label === '') return ['bad_label'];
  const conf = r.confidence;
  if (
    typeof conf !== 'number' || Number.isNaN(conf) || conf < 0 || conf > 1
  ) {
    return ['bad_confidence'];
  }
  const ood = r.oodIndicator;
  if (typeof ood !== 'object' || ood === null || Array.isArray(ood)) {
    return ['bad_ood_indicator'];
  }
  const o = ood as Record<string, unknown>;
  if (!('flag' in o) || !('reasons' in o)) return ['bad_ood_indicator'];
  const flag = o.flag;
  const reasons = o.reasons;
  if (!Array.isArray(reasons) || reasons.some((x) => typeof x !== 'string')) {
    return ['bad_ood_indicator'];
  }
  for (const reason of reasons) {
    if (!OOD_SET.has(reason)) return ['unknown_ood_reason'];
  }
  if (flag === true && reasons.length === 0) return ['ood_reason_required'];
  if (flag !== true && reasons.length > 0) return ['ood_flag_required'];
  if (r.label === 'unknown' && !(flag === true && reasons.length > 0)) {
    return ['unknown_requires_ood'];
  }
  if (!QUALITY_SET.has(String(r.dataQuality))) return ['bad_data_quality'];
  const evidence = r.evidence;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return ['bad_evidence'];
  }
  const ev = evidence as Record<string, unknown>;
  if (!('tsStart' in ev) || !('tsEnd' in ev) || !('isRule' in ev)) return ['bad_evidence'];
  if (typeof ev.isRule !== 'boolean') return ['bad_evidence'];
  if (typeof ev.tsStart !== 'string' || typeof ev.tsEnd !== 'string') return ['bad_evidence'];
  return [];
}
