"""LearningEvaluation 契约测试（ADR-021 / NO-09a，Phase 12 Continuous Learning）。

向量仲裁由 scripts/audit-domain-contracts.js（learning 域）承担；本文件覆盖
Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界（null 语义 /
period 契约 / 未知键拒绝）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import learning_evaluation as learn

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "learning" / "learning-evaluation.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = learn.validate_learning_evaluation(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent / "contracts" / "learning" / "learning-evaluation.schema.json",
        encoding="utf-8",
    ))
    assert list(learn.METRIC_KEYS) == schema["metricRegistry"]
    assert list(learn.EVALUATION_TYPES) == schema["evaluationTypeRegistry"]


def test_null_semantics():
    # 全 null = 无数据语义合法（§10 unknown 合法，绝不伪造）
    record = {
        "evalId": "le:x", "orgId": "org-1", "evaluationType": "periodic",
        "periodStart": "2026-08-16T00:00:00Z", "periodEnd": "2026-08-16T08:00:00Z",
        "engineVersion": "1.0.0",
        "metrics": {k: None for k in learn.METRIC_KEYS},
        "basis": ["x"], "auditTrail": True,
    }
    assert learn.validate_learning_evaluation(record) == []
    # 字符串伪造值拒绝
    record["metrics"] = {k: None for k in learn.METRIC_KEYS}
    record["metrics"]["planSuccessRate"] = "high"
    assert learn.validate_learning_evaluation(record)[0] == "bad_metric_value"
