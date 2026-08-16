"""OutcomeAnnotation 契约测试（ADR-034 / §10 Level 7 + §12：真值标注面）。

向量仲裁由 scripts/audit-domain-contracts.js（outcome_annotation 域）承担；
本文件覆盖 Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import outcome_annotation as oa

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "learning" / "outcome-annotation.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = oa.validate_outcome_annotation(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent
        / "contracts" / "learning" / "outcome-annotation.schema.json",
        encoding="utf-8",
    ))
    assert list(oa.TARGET_TYPES) == schema["targetTypeRegistry"]
    assert list(oa.OUTCOME_KINDS) == schema["outcomeKindRegistry"]


def test_key_boundaries():
    base = {
        "annotationId": "oa:x1", "targetType": "plan", "targetId": "PLAN-1",
        "outcomeKind": "success", "judgedBy": "person:op1",
        "judgedAt": "2026-08-16T12:00:00Z", "auditTrail": True,
    }
    assert oa.validate_outcome_annotation(base) == []
    assert oa.validate_outcome_annotation({**base, "targetType": "gizmo"})[0] == "unknown_target_type"
    assert oa.validate_outcome_annotation({**base, "outcomeKind": "meh"})[0] == "unknown_outcome_kind"
    assert oa.validate_outcome_annotation({k: v for k, v in base.items() if k != "judgedBy"})[0] == "missing_field:judgedBy"
    assert oa.validate_outcome_annotation({**base, "judgedBy": "  "})[0] == "judger_required"
    assert oa.validate_outcome_annotation({**base, "measured": {"delayMs": float("nan")}})[0] == "bad_measured"
    assert oa.validate_outcome_annotation({**base, "measured": {"delayMs": "x"}})[0] == "bad_measured"
    assert oa.validate_outcome_annotation({**base, "auditTrail": False})[0] == "audit_required"
