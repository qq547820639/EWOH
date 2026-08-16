"""Canonical Maintenance / Quality 契约测试（ADR-010 / NO-05a）。

契约文件合法性与注册表一致 + 共享测试向量全量执行（与 TS 侧
shared/maintenance-quality.spec.ts 消费同一份向量）。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

from edge_platform.contracts import maintenance as maint  # noqa: E402
from edge_platform.contracts import quality as qual  # noqa: E402


def _load(domain: str, name: str) -> dict:
    with (REPO_ROOT / "contracts" / domain / name).open("r", encoding="utf-8") as fh:
        return json.load(fh)


class TestMQContractFiles:
    def test_schemas_and_vectors_parse(self):
        for domain in ("maintenance", "quality"):
            schema = _load(domain, f"{domain}.schema.json")
            vectors = _load(domain, "test-vectors.json")
            assert schema["schemaVersion"] == "1.0.0"
            assert vectors["schemaVersion"] == "1.0.0"
            assert schema["$id"] == f"ewoh:///{domain}/{domain}/v1"

    def test_python_registries_match_schemas(self):
        ms = _load("maintenance", "maintenance.schema.json")
        assert maint.CONDITION_TYPES == frozenset(ms["conditionTypeRegistry"])
        assert maint.LIFECYCLE == tuple(ms["lifecycle"])
        qs = _load("quality", "quality.schema.json")
        assert qual.FINDING_TYPES == frozenset(qs["findingTypeRegistry"])
        assert qual.LIFECYCLE == tuple(qs["lifecycle"])
        assert qual.DISPOSITIONS == frozenset(qs["dispositionRegistry"])


class TestMaintenanceVectors:
    def test_conditions(self):
        for case in _load("maintenance", "test-vectors.json")["conditions"]:
            errors = maint.validate_condition(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)

    def test_transitions(self):
        for case in _load("maintenance", "test-vectors.json")["transitions"]:
            assert maint.transition_allowed(case["from"], case["to"]) is case["allowed"], case

    def test_overdue(self):
        for case in _load("maintenance", "test-vectors.json")["overdue"]:
            assert maint.is_overdue(case["dueAt"], case["status"], case["now"]) is case["expect"], case["name"]


class TestQualityVectors:
    def test_findings(self):
        for case in _load("quality", "test-vectors.json")["findings"]:
            errors = qual.validate_finding(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)

    def test_transitions(self):
        for case in _load("quality", "test-vectors.json")["transitions"]:
            assert qual.transition_allowed(case["from"], case["to"]) is case["allowed"], case
