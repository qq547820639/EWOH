"""Canonical Quality Finding Model（统一质量发现契约，ADR-010 / NO-05a）。

权威契约：contracts/quality/quality.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- findingType 封闭注册表；links 必须是规范身份（ADR-006）；
- severity 走 Canonical Risk 阶梯；
- 处置生命周期 open→under_review→dispositioned→closed
  （dispositioned 必带 disposition 决策 accept/rework/scrap/return；closed 终态）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity
from .risk import DomainContractError, normalize_severity

FINDING_TYPES: frozenset = frozenset(
    {"defect", "dimension_out_of_tolerance", "nonconformance", "material_mismatch", "process_deviation"}
)
LIFECYCLE: tuple[str, ...] = ("open", "under_review", "dispositioned", "closed")
DISPOSITIONS: frozenset = frozenset({"accept", "rework", "scrap", "return"})

_TRANSITIONS: frozenset = frozenset(
    {
        ("open", "under_review"),
        ("under_review", "dispositioned"),
        ("dispositioned", "closed"),
    }
)


def is_valid_finding_type(value: str) -> bool:
    return value in FINDING_TYPES


def is_valid_disposition(value: str) -> bool:
    return value in DISPOSITIONS


def is_valid_status(value: str) -> bool:
    return value in LIFECYCLE


def transition_allowed(from_status: str, to_status: str) -> bool:
    if not is_valid_status(from_status) or not is_valid_status(to_status):
        return False
    return (from_status, to_status) in _TRANSITIONS


def validate_finding(record: Any) -> list[str]:
    """校验 QualityFinding 记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in ("findingId", "findingType", "severity", "status"):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["findingId"], str) or not record["findingId"]:
        return ["bad_finding_id"]
    if record["findingType"] not in FINDING_TYPES:
        return ["unknown_finding_type"]
    if not isinstance(record["severity"], str):
        return ["unknown_severity"]
    try:
        normalize_severity(record["severity"])
    except DomainContractError:
        return ["unknown_severity"]
    status = record["status"]
    if status not in LIFECYCLE:
        return ["unknown_status"]
    links = record.get("links", [])
    if not isinstance(links, list):
        return ["bad_links"]
    for link in links:
        if not isinstance(link, str) or not is_canonical_identity(link):
            return ["bad_link"]
    disposition = record.get("disposition")
    if status == "dispositioned":
        if disposition not in DISPOSITIONS:
            return ["disposition_required"] if disposition is None else ["unknown_disposition"]
    elif disposition is not None:
        if disposition not in DISPOSITIONS:
            return ["unknown_disposition"]
    return []
