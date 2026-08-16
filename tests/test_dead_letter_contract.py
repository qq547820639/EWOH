"""DeadLetter 契约测试（ADR-024 / NO-11a，§20 Reliability 失败终态）。

向量仲裁由 scripts/audit-domain-contracts.js（dead_letter 域）承担；本文件
覆盖 Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import dead_letter as dead

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "reliability" / "dead-letter.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = dead.validate_dead_letter(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent
        / "contracts" / "reliability" / "dead-letter.schema.json",
        encoding="utf-8",
    ))
    assert list(dead.REASONS) == schema["reasonRegistry"]
    assert list(dead.STATUSES) == schema["statusRegistry"]


def test_key_boundaries():
    base = {
        "letterId": "dl:x:E1", "sourceId": "cloud:ingest", "reason": "permanent_failure",
        "attempts": 1, "status": "pending", "envelope": {"eventId": "E1"},
        "correlationId": None, "auditTrail": True,
    }
    assert dead.validate_dead_letter(base) == []
    assert dead.validate_dead_letter({**base, "attempts": 0})[0] == "bad_attempts"
    assert dead.validate_dead_letter({**base, "status": "discarded"})[0] == "discard_reason_required"
    assert dead.validate_dead_letter({**base, "envelope": {}})[0] == "envelope_required"
    assert dead.validate_dead_letter({**base, "reason": "gizmo"})[0] == "unknown_reason"
