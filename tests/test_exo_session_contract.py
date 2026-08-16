"""ExoSession 契约测试（ADR-032 / §7：外骨骼↔人员绑定 Session）。

向量仲裁由 scripts/audit-domain-contracts.js（exo 域）承担；本文件覆盖
Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界 + 状态机。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import exo_session as exo

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "exo" / "exo-session.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = exo.validate_exo_session(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent
        / "contracts" / "exo" / "exo-session.schema.json",
        encoding="utf-8",
    ))
    assert list(exo.STATUSES) == schema["statusRegistry"]


def test_key_boundaries():
    base = {
        "sessionId": "exo-session:x1",
        "exoId": "device:e1",
        "personId": "person:p1",
        "status": "active",
        "startedAt": "2026-08-16T08:00:00Z",
        "auditTrail": True,
    }
    assert exo.validate_exo_session(base) == []
    assert exo.validate_exo_session({**base, "status": "paused"})[0] == "unknown_status"
    assert exo.validate_exo_session({**base, "exoId": "EXO-1"})[0] == "bad_exo_identity"
    assert exo.validate_exo_session({**base, "personId": "P-1"})[0] == "bad_person_identity"
    assert exo.validate_exo_session(
        {**base, "status": "ended", "endedBy": "person:op1"},
    )[0] == "actual_end_required"
    assert exo.validate_exo_session(
        {**base, "status": "aborted", "actualEndAt": "2026-08-16T07:00:00Z", "endedBy": "person:op1"},
    )[0] == "bad_time_order"
    assert exo.validate_exo_session({**base, "actualEndAt": "2026-08-16T09:00:00Z"})[0] == "actual_end_not_allowed"
    assert exo.validate_exo_session({**base, "auditTrail": False})[0] == "audit_required"


def test_transitions():
    assert exo.exo_session_transition_allowed("active", "ended")
    assert exo.exo_session_transition_allowed("active", "aborted")
    assert not exo.exo_session_transition_allowed("ended", "active")
    assert not exo.exo_session_transition_allowed("aborted", "active")
    assert not exo.exo_session_transition_allowed("active", "active")
