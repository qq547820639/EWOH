/* 前后端共享契约 - Canonical Knowledge Entry（ADR-018 / NO-07，Factory Knowledge System）。
 *
 * 权威契约：contracts/knowledge/knowledge-entry.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/knowledge.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';
import { parseEnvelopeTs } from './event-envelope';

export const KNOWLEDGE_KINDS = [
  'incident', 'resolution', 'failure_pattern', 'process_knowledge',
  'decision_history', 'evidence',
] as const;

/** 五层有序阶梯：global > industry > customer > factory > private_operational（泄露方向）。 */
export const KNOWLEDGE_SCOPES = [
  'global', 'industry', 'customer', 'factory', 'private_operational',
] as const;

export const KNOWLEDGE_STATUSES = ['draft', 'verified', 'superseded'] as const;

const KIND_SET: ReadonlySet<string> = new Set(KNOWLEDGE_KINDS);
const SCOPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_SCOPES);
const STATUS_SET: ReadonlySet<string> = new Set(KNOWLEDGE_STATUSES);

const TENANT_REQUIRED_SCOPES: ReadonlySet<string> = new Set(['customer', 'factory', 'private_operational']);
const SHARED_SCOPES: ReadonlySet<string> = new Set(['global', 'industry']);
const PROVENANCE_FIELDS = ['trainingDataSources', 'anonymizationPolicy', 'dataAuthorization', 'modelVersion'] as const;

const REQUIRED_FIELDS = [
  'knowledgeId', 'kind', 'scope', 'title', 'summary', 'body',
  'sourceEvidenceIds', 'relatedEntityIds', 'tags', 'version', 'status',
  'timeSemantics', 'auditTrail',
] as const;

/** 校验知识条目；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateKnowledgeEntry(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.knowledgeId !== 'string' || !isCanonicalIdentity(r.knowledgeId)) {
    return ['bad_knowledge_id'];
  }
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!SCOPE_SET.has(String(r.scope))) return ['unknown_scope'];
  if (typeof r.title !== 'string' || r.title.trim() === '') return ['bad_title'];
  if (typeof r.summary !== 'string' || r.summary.trim() === '') return ['bad_summary'];
  if (typeof r.body !== 'string' || r.body.trim() === '') return ['bad_body'];
  const evidenceIds = r.sourceEvidenceIds;
  if (!Array.isArray(evidenceIds) || evidenceIds.some((e) => typeof e !== 'string' || !isCanonicalIdentity(e))) {
    return ['bad_evidence_ref'];
  }
  if (evidenceIds.length === 0) return ['empty_evidence'];
  const relatedIds = r.relatedEntityIds;
  if (!Array.isArray(relatedIds) || relatedIds.some((x) => typeof x !== 'string' || !isCanonicalIdentity(x))) {
    return ['bad_entity_ref'];
  }
  const tags = r.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 64)) {
    return ['bad_tag'];
  }
  const version = r.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return ['bad_version'];
  }
  if (!STATUS_SET.has(String(r.status))) return ['bad_status'];
  const verifiedBy = r.verifiedBy;
  if (verifiedBy != null && (typeof verifiedBy !== 'string' || !isCanonicalIdentity(verifiedBy))) {
    return ['bad_verifier'];
  }
  const scope = String(r.scope);
  const tenantId = r.tenantId;
  if (TENANT_REQUIRED_SCOPES.has(scope)) {
    if (typeof tenantId !== 'string' || tenantId === '') return ['tenant_required'];
  } else if (SHARED_SCOPES.has(scope)) {
    if (tenantId != null) return ['tenant_forbidden'];
  }
  const provenance = r.provenance;
  if (SHARED_SCOPES.has(scope)) {
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
      return ['provenance_required'];
    }
    const p = provenance as Record<string, unknown>;
    const sources = p.trainingDataSources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.some((item) => typeof item !== 'string' || item.trim() === '')) {
      return ['provenance_required'];
    }
    for (const field of PROVENANCE_FIELDS.slice(1)) {
      if (typeof p[field] !== 'string' || (p[field] as string).trim() === '') {
        return ['provenance_required'];
      }
    }
  } else if (scope === 'private_operational') {
    if (provenance != null) return ['provenance_forbidden'];
  } else if (provenance != null && (typeof provenance !== 'object' || Array.isArray(provenance))) {
    return ['bad_provenance'];
  }
  const timeSem = r.timeSemantics;
  if (typeof timeSem !== 'object' || timeSem === null || Array.isArray(timeSem)) {
    return ['bad_time'];
  }
  const ts = timeSem as Record<string, unknown>;
  if (!('validFrom' in ts)) return ['bad_time'];
  const validFrom = parseEnvelopeTs(String(ts.validFrom));
  if (validFrom == null) return ['bad_time'];
  if (ts.validTo != null) {
    const validTo = parseEnvelopeTs(String(ts.validTo));
    if (validTo == null || validTo < validFrom) return ['bad_time'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}
