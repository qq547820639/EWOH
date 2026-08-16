"""MetricsRegistry 契约测试（ADR-023 / NO-10b，§19 指标腿）。

向量仲裁由 scripts/audit-domain-contracts.js（metrics 域）承担；本文件覆盖
Python 侧向量一致性 + 注册表与 schema 交叉核对（含 name→type→labelKeys
深一致）+ 关键边界（counter 非负 / histogram le / 未知标签）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import metrics_registry as metrics

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "observability" / "metrics-registry.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = metrics.validate_metric_sample(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registry_matches_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent
        / "contracts" / "observability" / "metrics-registry.schema.json",
        encoding="utf-8",
    ))
    assert list(metrics.METRIC_TYPES) == schema["metricTypeRegistry"]
    assert list(metrics.METRIC_LABEL_KEYS) == schema["labelKeyRegistry"]
    py_registry = sorted(
        [{"name": n, "type": t, "labelKeys": list(l)} for n, t, l in metrics.METRIC_REGISTRY],
        key=lambda e: e["name"],
    )
    schema_registry = sorted(schema["metricRegistry"], key=lambda e: e["name"])
    assert py_registry == schema_registry


def test_key_boundaries():
    assert metrics.validate_metric_sample({
        "metricName": "agent_command_executed_total", "metricType": "counter",
        "value": -1, "labels": {},
    })[0] == "bad_value"
    assert metrics.validate_metric_sample({
        "metricName": "scheduler_run_duration_ms", "metricType": "histogram",
        "value": 1.5, "labels": {},
    })[0] == "histogram_le_required"
    assert metrics.validate_metric_sample({
        "metricName": "agent_command_executed_total", "metricType": "counter",
        "value": 2, "labels": {"teleport": "x"},
    })[0] == "unknown_label"
