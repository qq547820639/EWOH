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
SCHEMA_PATH = REPO_ROOT / "contracts" / "decision" / "decision.schema.json"


def _load() -> list:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["records"]


@pytest.mark.parametrize("case", _load(), ids=[c["name"] for c in _load()])
def test_vector(case):
    errors = dec.validate_decision(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    """TEST-005：加载 decision.schema.json 与 Python 注册表逐项交叉核对（顺序敏感）。"""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert list(dec.DECISION_KINDS) == schema["decisionKinds"]
    assert list(dec.DECISION_STATUSES) == schema["decisionStatuses"]
    assert list(dec.DECISION_AUTHORITIES) == schema["decisionAuthorities"]
    assert list(dec.RISK_LEVELS) == schema["riskLevels"]
    # properties.enum 与注册表同源一致性
    assert schema["properties"]["kind"]["enum"] == list(dec.DECISION_KINDS)
    assert schema["properties"]["status"]["enum"] == list(dec.DECISION_STATUSES)
    assert schema["properties"]["decisionAuthority"]["enum"] == list(dec.DECISION_AUTHORITIES)
    assert schema["properties"]["riskLevel"]["enum"] == list(dec.RISK_LEVELS)


def test_risk_ladder_single_source():
    # §31：决策契约不重复定义风险阶梯——import 即事实源。
    assert dec.RISK_LEVELS is SEVERITY_LADDER
    assert list(dec.RISK_LEVELS) == ["critical", "high", "medium", "low"]
