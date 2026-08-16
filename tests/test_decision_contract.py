"""Canonical Decision Model 契约测试（ADR-047 / NO-12x，§2/§3/§18）。

从 contracts/decision/decision.test-vectors.json 加载共享向量逐条校验
Python 实现（audit-domain-contracts decision 域独立仲裁 + Golden 第 24
场景双执行器之外的本机回归面）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import decision as dec
from edge_platform.contracts.risk import SEVERITY_LADDER

REPO_ROOT = Path(__file__).resolve().parent.parent
VECTORS_PATH = REPO_ROOT / "contracts" / "decision" / "decision.test-vectors.json"


def _load() -> list:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["records"]


@pytest.mark.parametrize("case", _load(), ids=[c["name"] for c in _load()])
def test_vector(case):
    errors = dec.validate_decision(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_shape():
    assert len(dec.DECISION_KINDS) == 8
    assert len(dec.DECISION_STATUSES) == 5
    assert len(dec.DECISION_AUTHORITIES) == 5


def test_risk_ladder_single_source():
    # §31：决策契约不重复定义风险阶梯——import 即事实源。
    assert dec.RISK_LEVELS is SEVERITY_LADDER
    assert list(dec.RISK_LEVELS) == ["critical", "high", "medium", "low"]
