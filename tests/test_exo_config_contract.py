"""Canonical Exo Configuration Model 契约测试（ADR-051 / NO-13b，§7）。

从 contracts/exo/exo-config.test-vectors.json 加载共享向量逐条校验
Python 实现（audit-domain-contracts exo-config 域独立仲裁 + Golden
第 25 场景双执行器之外的本机回归面）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import exo_config as exc

REPO_ROOT = Path(__file__).resolve().parent.parent
VECTORS_PATH = REPO_ROOT / "contracts" / "exo" / "exo-config.test-vectors.json"
SCHEMA_PATH = REPO_ROOT / "contracts" / "exo" / "exo-config.schema.json"


def _load() -> list:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["records"]


@pytest.mark.parametrize("case", _load(), ids=[c["name"] for c in _load()])
def test_vector(case):
    errors = exc.validate_exo_config(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    """TEST-007：加载 exo-config.schema.json 与 Python 注册表逐项交叉核对（顺序敏感）。"""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert list(exc.EXO_CONFIG_KINDS) == schema["exoConfigKinds"]
    assert list(exc.SUPPORT_MODES) == schema["supportModes"]
    assert list(exc.CALIBRATION_KINDS) == schema["calibrationKinds"]
    assert list(exc.PROFILE_STATUSES) == schema["profileStatuses"]
    assert list(exc.FIT_STATUSES) == schema["fitStatuses"]
    assert list(exc.CALIBRATION_STATUSES) == schema["calibrationStatuses"]
    # properties.enum 与注册表同源一致性
    assert schema["properties"]["kind"]["enum"] == list(exc.EXO_CONFIG_KINDS)
    assert schema["properties"]["supportMode"]["enum"] == list(exc.SUPPORT_MODES)
    assert schema["properties"]["calibrationKind"]["enum"] == list(exc.CALIBRATION_KINDS)
