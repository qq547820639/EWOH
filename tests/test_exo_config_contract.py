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


def _load() -> list:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["records"]


@pytest.mark.parametrize("case", _load(), ids=[c["name"] for c in _load()])
def test_vector(case):
    errors = exc.validate_exo_config(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_shape():
    assert len(exc.EXO_CONFIG_KINDS) == 3
    assert len(exc.SUPPORT_MODES) == 8
    assert len(exc.CALIBRATION_KINDS) == 3
    assert len(exc.PROFILE_STATUSES) == 3
    assert len(exc.FIT_STATUSES) == 4
    assert len(exc.CALIBRATION_STATUSES) == 3
