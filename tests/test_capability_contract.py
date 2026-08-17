"""Canonical Capability Model 契约测试（ADR-043 / NO-12t，§3/§4）。

从 contracts/capability/capability.test-vectors.json 加载共享向量逐条
校验 Python 实现（audit-domain-contracts capability 域独立仲裁 +
Golden 第 23 场景双执行器之外的本机回归面）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import capability as cap

REPO_ROOT = Path(__file__).resolve().parent.parent
VECTORS_PATH = REPO_ROOT / "contracts" / "capability" / "capability.test-vectors.json"
SCHEMA_PATH = REPO_ROOT / "contracts" / "capability" / "capability.schema.json"


def _load() -> list:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["records"]


@pytest.mark.parametrize("case", _load(), ids=[c["name"] for c in _load()])
def test_vector(case):
    errors = cap.validate_capability(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    """TEST-006：加载 capability.schema.json 与 Python 注册表逐项交叉核对（顺序敏感）。"""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert list(cap.CAPABILITY_KINDS) == schema["capabilityKinds"]
    assert list(cap.PROVIDER_TYPES) == schema["providerTypes"]
    assert list(cap.KNOWN_VALUES) == schema["knownValues"]
    for value in cap.KNOWN_VALUES:
        assert isinstance(value, str) and value
    # properties.enum 与注册表同源一致性
    assert schema["properties"]["kind"]["enum"] == list(cap.CAPABILITY_KINDS)
    assert schema["properties"]["providerType"]["enum"] == list(cap.PROVIDER_TYPES)
