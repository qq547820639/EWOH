"""Canonical Knowledge Entry 契约（ADR-018 / NO-07，Factory Knowledge System 立项）。

权威契约：contracts/knowledge/knowledge-entry.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js knowledge
域门禁强制。

语义（§12 + ADR-018）：
- 知识条目是 Evidence 之上的派生资产：sourceEvidenceIds 非空（可追溯证据链，
  §3 Factory Truth）；relatedEntityIds 形成知识图边；
- scope 五层有序阶梯：global/industry（跨租户共享——provenance 必填、
  tenantId 禁止）/customer/factory（tenantId 必填）/private_operational
  （永不出租户，provenance 禁止）——§15/§16 跨工厂隔离政策的机器执行面；
- status ∈ {draft, verified, superseded}（人工 verifiedBy 可审计）；
- timeSemantics 双时态（与 ADR-008 同源）；auditTrail 必须 true。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

KNOWLEDGE_KINDS: tuple[str, ...] = (
    "incident", "resolution", "failure_pattern", "process_knowledge",
    "decision_history", "evidence",
)
# 有序阶梯：global > industry > customer > factory > private_operational（泄露方向）
KNOWLEDGE_SCOPES: tuple[str, ...] = ("global", "industry", "customer", "factory", "private_operational")
KNOWLEDGE_STATUSES: tuple[str, ...] = ("draft", "verified", "superseded")

_TENANT_REQUIRED_SCOPES = frozenset({"customer", "factory", "private_operational"})
_SHARED_SCOPES = frozenset({"global", "industry"})
_PROVENANCE_FIELDS = ("trainingDataSources", "anonymizationPolicy", "dataAuthorization", "modelVersion")

_REQUIRED_FIELDS = (
    "knowledgeId", "kind", "scope", "title", "summary", "body",
    "sourceEvidenceIds", "relatedEntityIds", "tags", "version", "status",
    "timeSemantics", "auditTrail",
)


def _parse_iso(value: Any):
    from .envelope import parse_ts

    return parse_ts(value) if isinstance(value, str) else None


def validate_knowledge_entry(record: Any) -> list[str]:
    """校验知识条目；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["knowledgeId"], str) or not is_canonical_identity(record["knowledgeId"]):
        return ["bad_knowledge_id"]
    if record["kind"] not in KNOWLEDGE_KINDS:
        return ["unknown_kind"]
    if record["scope"] not in KNOWLEDGE_SCOPES:
        return ["unknown_scope"]
    if not isinstance(record["title"], str) or not record["title"].strip():
        return ["bad_title"]
    if not isinstance(record["summary"], str) or not record["summary"].strip():
        return ["bad_summary"]
    if not isinstance(record["body"], str) or not record["body"].strip():
        return ["bad_body"]
    evidence_ids = record["sourceEvidenceIds"]
    if not isinstance(evidence_ids, list) or any(
        not isinstance(e, str) or not is_canonical_identity(e) for e in evidence_ids
    ):
        return ["bad_evidence_ref"]
    if len(evidence_ids) == 0:
        return ["empty_evidence"]
    related_ids = record["relatedEntityIds"]
    if not isinstance(related_ids, list) or any(
        not isinstance(r, str) or not is_canonical_identity(r) for r in related_ids
    ):
        return ["bad_entity_ref"]
    tags = record["tags"]
    if not isinstance(tags, list) or any(
        not isinstance(t, str) or not 1 <= len(t) <= 64 for t in tags
    ):
        return ["bad_tag"]
    version = record["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return ["bad_version"]
    if record["status"] not in KNOWLEDGE_STATUSES:
        return ["bad_status"]
    verified_by = record.get("verifiedBy")
    if verified_by is not None and (
        not isinstance(verified_by, str) or not is_canonical_identity(verified_by)
    ):
        return ["bad_verifier"]
    scope = record["scope"]
    tenant_id = record.get("tenantId")
    if scope in _TENANT_REQUIRED_SCOPES:
        if not isinstance(tenant_id, str) or not tenant_id:
            return ["tenant_required"]
    elif scope in _SHARED_SCOPES:
        if tenant_id is not None:
            return ["tenant_forbidden"]
    provenance = record.get("provenance")
    if scope in _SHARED_SCOPES:
        if not isinstance(provenance, dict):
            return ["provenance_required"]
        sources = provenance.get("trainingDataSources")
        if not isinstance(sources, list) or len(sources) == 0 or any(
            not isinstance(item, str) or not item for item in sources
        ):
            return ["provenance_required"]
        for field in _PROVENANCE_FIELDS[1:]:
            if not isinstance(provenance.get(field), str) or not provenance.get(field):
                return ["provenance_required"]
    elif scope == "private_operational":
        if provenance is not None:
            return ["provenance_forbidden"]
    elif provenance is not None and not isinstance(provenance, dict):
        return ["bad_provenance"]
    time_sem = record["timeSemantics"]
    if not isinstance(time_sem, dict) or "validFrom" not in time_sem:
        return ["bad_time"]
    valid_from = _parse_iso(time_sem["validFrom"])
    if valid_from is None:
        return ["bad_time"]
    valid_to = time_sem.get("validTo")
    if valid_to is not None:
        valid_to_ms = _parse_iso(valid_to)
        if valid_to_ms is None or valid_to_ms < valid_from:
            return ["bad_time"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []
