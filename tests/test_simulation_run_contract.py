"""SimulationRun 契约测试（ADR-025 / NO-12a，§13 Digital Twin Simulation）。

向量仲裁由 scripts/audit-domain-contracts.js（simulation 域）承担；本文件
覆盖 Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界 +
四类确定性评估器（与 TS 端共享 Golden #19 执行向量约束）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import simulation_run as sim

VECTORS_PATH = Path(__file__).resolve().parent.parent / "contracts" / "simulation" / "simulation-run.test-vectors.json"

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = sim.validate_simulation_run(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(
        open(
            Path(__file__).resolve().parent.parent / "contracts" / "simulation" / "simulation-run.schema.json",
            encoding="utf-8",
        )
    )
    assert list(sim.KINDS) == schema["kindRegistry"]
    assert list(sim.STATUSES) == schema["statusRegistry"]


def test_key_boundaries():
    base = {
        "runId": "sim:x:1",
        "kind": "what_if",
        "status": "created",
        "isSimulation": True,
        "baseRef": {"snapshotVersion": 0},
        "parameters": {},
        "engineVersion": "1.0.0",
        "auditTrail": True,
    }
    assert sim.validate_simulation_run(base) == []
    assert sim.validate_simulation_run({**base, "isSimulation": False})[0] == "isolation_required"
    assert sim.validate_simulation_run({**base, "kind": "gizmo"})[0] == "unknown_kind"
    assert sim.validate_simulation_run({**base, "status": "completed"})[0] == "results_required"
    assert sim.validate_simulation_run({**base, "status": "failed"})[0] == "failure_reason_required"
    assert sim.validate_simulation_run({**base, "auditTrail": False})[0] == "audit_required"
    assert sim.validate_simulation_run({**base, "baseRef": {"snapshotVersion": -1}})[0] == "bad_base_ref"


def test_evaluators_deterministic():
    capacity = sim.evaluate_capacity(
        [{"stationId": "station:s1", "capacityPerHour": 10}, {"stationId": "station:s2", "capacityPerHour": 25}],
        12,
    )
    assert capacity == {
        "bottleneckStationId": "station:s1",
        "lineThroughputPerHour": 10.0,
        "utilization": 1.2,
        "overloaded": True,
    }
    layout = sim.evaluate_layout(
        [{"stationId": "station:s1", "x": 0, "y": 0}, {"stationId": "station:s2", "x": 3, "y": 4}],
        [{"fromStationId": "station:s1", "toStationId": "station:s2", "trips": 10}],
    )
    assert layout["totalTravelDistance"] == 50.0
    flow = sim.evaluate_material_flow(
        [
            {"stationId": "station:s1", "capacityPerHour": 10, "inflowPerHour": 8},
            {"stationId": "station:s2", "capacityPerHour": 20, "inflowPerHour": 25.5},
        ],
    )
    assert flow["bottleneckStationId"] == "station:s2"
    assert flow["bottleneckLoadRatio"] == 1.275
    what_if = sim.evaluate_what_if(
        "trace:t1",
        [{"ruleId": "rule:r1", "subjectId": "station:s1", "conclusion": "overload", "confidence": 0.8}],
        [{"ruleId": "rule:r2", "subjectId": "station:s3", "conclusion": "normal", "confidence": 0.9}],
    )
    assert what_if["baseCount"] == 1
    assert what_if["scenarioCount"] == 1
    assert len(what_if["added"]) == 1
    assert len(what_if["removed"]) == 1


def test_evaluators_fail_closed():
    with pytest.raises(ValueError):
        sim.evaluate_capacity([], 10)
    with pytest.raises(ValueError):
        sim.evaluate_layout(
            [{"stationId": "station:s1", "x": 0, "y": 0}],
            [{"fromStationId": "station:s1", "toStationId": "station:ghost", "trips": 1}],
        )
    with pytest.raises(ValueError):
        sim.evaluate_material_flow(
            [{"stationId": "station:s1", "capacityPerHour": 0, "inflowPerHour": 1}],
        )
    with pytest.raises(ValueError):
        sim.evaluate_what_if("trace:t1", "not-a-list", [])  # type: ignore[arg-type]
