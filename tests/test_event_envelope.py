"""Canonical Event Envelope 契约测试（ADR-009 / NO-04）。

- 契约文件合法性与目录交叉校验（向量 eventType 必须命中事件目录 x-event-types）；
- 共享测试向量全量执行（与 TS 侧 event-envelope.spec.ts 消费同一份向量）。
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "contracts" / "events" / "envelope.schema.json"
VECTORS_PATH = REPO_ROOT / "contracts" / "events" / "envelope-test-vectors.json"
CATALOG_PATH = REPO_ROOT / "contracts" / "events" / "event-catalog.yaml"

from edge_platform.contracts import envelope as env  # noqa: E402


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _catalog_types() -> frozenset:
    with CATALOG_PATH.open("r", encoding="utf-8") as fh:
        catalog = yaml.safe_load(fh)
    return frozenset(catalog["x-event-types"])


class TestEnvelopeContractFiles:
    def test_schema_and_vectors_parse(self):
        schema = _load_json(SCHEMA_PATH)
        vectors = _load_json(VECTORS_PATH)
        assert schema["schemaVersion"] == "1.0.0"
        assert vectors["schemaVersion"] == "1.0.0"
        assert schema["$id"] == "ewoh:///events/envelope/v1"
        assert schema["clockDriftToleranceMs"] == env.CLOCK_DRIFT_TOLERANCE_MS
        assert schema["lateThresholdMs"] == env.LATE_THRESHOLD_MS

    def test_vector_event_types_hit_catalog(self):
        known = _catalog_types()
        for case in _load_json(VECTORS_PATH)["envelopes"]:
            # 负向控制（期望 unknown_event_type）除外——它们的存在正是为了验证拒绝语义
            if case.get("expectError") == "unknown_event_type":
                continue
            et = case["envelope"].get("eventType")
            if et is not None:
                assert et in known, f"向量 eventType 不在事件目录: {et}"


class TestEnvelopeVectors:
    def test_envelopes(self):
        known = _catalog_types()
        for case in _load_json(VECTORS_PATH)["envelopes"]:
            errors = env.validate_envelope(case["envelope"], known)
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
                if "expect" in case and case["expect"] is not None:
                    assert env.envelope_semantics(case["envelope"]) == case["expect"], case["name"]
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)

    def test_dedup_key_stable(self):
        e = {
            "eventId": "EVT-X",
            "eventType": "TelemetryObserved",
            "schemaVersion": "1.0.0",
            "occurredAt": "2026-08-14T08:00:00Z",
            "source": "edge:ny-exo-a1",
        }
        assert env.dedup_key(e) == ("edge:ny-exo-a1", "EVT-X")
