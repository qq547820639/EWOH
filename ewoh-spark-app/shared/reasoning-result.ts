/* 前后端共享契约 - Canonical Reasoning Result Model（ADR-014 / NO-08c）。
 *
 * 权威契约：contracts/reasoning/reasoning-result.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/reasoning_result.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';

export const REASONING_LEVELS = [
  'L4_industrial_reasoning', 'L5_agentic_workflow',
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const REASONING_KINDS = [
  'suggestion', 'explanation', 'analysis', 'chat',
] as const;
export type ReasoningKind = (typeof REASONING_KINDS)[number];

const LEVEL_SET: ReadonlySet<string> = new Set(REASONING_LEVELS);
const KIND_SET: ReadonlySet<string> = new Set(REASONING_KINDS);

/** 校验 ReasoningResult 记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateReasoningResult(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of [
    'reasoningId', 'level', 'kind', 'modelId', 'modelVersion', 'inputVersion',
    'subjectId', 'content', 'ok', 'error', 'confidence', 'confidenceBasis', 'evidence',
  ]) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.reasoningId !== 'string' || r.reasoningId === '') return ['bad_reasoning_id'];
  if (!LEVEL_SET.has(String(r.level))) return ['unknown_level'];
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  for (const key of ['modelId', 'modelVersion', 'inputVersion']) {
    if (typeof r[key] !== 'string' || r[key] === '') return [`bad_${key}`];
  }
  const subject = r.subjectId;
  if (subject != null && (typeof subject !== 'string' || !isCanonicalIdentity(subject))) {
    return ['bad_subject'];
  }
  if (typeof r.content !== 'string') return ['bad_content'];
  const ok = r.ok;
  if (typeof ok !== 'boolean') return ['bad_ok'];
  const error = r.error;
  if (ok === true) {
    if (r.content === '') return ['empty_content'];
    if (error != null) return ['error_forbidden'];
  } else {
    if (typeof error !== 'string' || error === '') return ['error_required'];
  }
  if (r.confidence != null) return ['confidence_forbidden'];
  if (r.confidenceBasis !== 'uncalibrated') return ['confidence_basis_required'];
  const evidence = r.evidence;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return ['bad_evidence'];
  }
  const ev = evidence as Record<string, unknown>;
  if (!('generatedAt' in ev)) return ['bad_evidence'];
  if (typeof ev.generatedAt !== 'string' || ev.generatedAt === '') return ['bad_evidence'];
  return [];
}
