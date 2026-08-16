"""Canonical World State 契约测试（ADR-008 / NO-03）。

- 契约文件合法性与注册表一致性（schema / vectors / Python 锁定注册表）；
- 共享测试向量全量执行（stateRecords / transitions / snapshots），
  与 TS 侧 shared/world-contract.spec.ts 消费同一份向量。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "contracts" / "world" / "world-state.schema.json"
VECTORS_PATH = REPO_ROOT / "contracts" / "world" / "test-vectors.json"

from edge_platform.contracts import world as wm  # noqa: E402


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


class TestWorldContractFiles:
    def test_schema_and_vectors_parse(self):
        schema = _load(SCHEMA_PATH)
        vectors = _load(VECTORS_PATH)
        assert schema["schemaVersion"] == "1.0.0"
        assert vectors["schemaVersion"] == "1.0.0"
        assert schema["$id"] == "ewoh:///world/world-state/v1"

    def test_python_registries_match_schema(self):
        schema = _load(SCHEMA_PATH)
        assert wm.ENTITY_TYPES == frozenset(schema["entityTypeRegistry"])
        assert wm.SOURCE_TYPES == frozenset(schema["sourceTypeRegistry"])


class TestWorldVectors:
    def test_state_records(self):
        for case in _load(VECTORS_PATH)["stateRecords"]:
            errors = wm.validate_state_record(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)

    def test_transitions(self):
        for case in _load(VECTORS_PATH)["transitions"]:
            records = [
                {
                    "entityId": case["entityId"],
                    "stateType": case["stateType"],
                    "validFrom": st["validFrom"],
                    "validTo": st["validTo"],
                    "version": st["version"],
                }
                for st in case["states"]
            ]
            errors = wm.validate_interval_set(records)
            if case["expect"]["valid"]:
                assert errors == [], (case["name"], errors)
                if "currentVersion" in case["expect"]:
                    current = [r for r in records if r["validTo"] is None]
                    assert current[0]["version"] == case["expect"]["currentVersion"], case["name"]
            else:
                assert case["expect"]["reason"] in errors, (case["name"], errors)

    def test_snapshots(self):
        for case in _load(VECTORS_PATH)["snapshots"]:
            errors = wm.validate_snapshot(case["snapshot"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
                if "expect" in case and case["expect"] is not None:
                    profile = wm.snapshot_source_profile(case["snapshot"]["states"])
                    assert profile == case["expect"], case["name"]
            else:
                assert case["expectError"] in errors, (case["name"], errors)
