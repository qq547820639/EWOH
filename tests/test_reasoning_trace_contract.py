"""ReasoningTrace 契约测试（ADR-020 / NO-08b，Level 4 独立工业推理层）。

向量仲裁由 scripts/audit-domain-contracts.js（reasoning_trace 域）承担；
本文件覆盖：Python 侧向量一致性 + 规则评估器与 Golden 期望的交叉核对 +
与 TS 语义一致的关键边界（确定性置信度 / 空结论 / 模板渲染）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import reasoning_trace as rtr

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "reasoning" / "reasoning-trace.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]

EVID = ["event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"]
PERSON = "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = rtr.validate_reasoning_trace(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def _fact(subject_id, kind, values):
    return {"subjectId": subject_id, "kind": kind, "values": values, "evidenceIds": EVID}


def test_evaluate_rules_six_rules_ordered():
    conclusions = rtr.evaluate_rules(
        "rt-py1",
        [
            _fact(PERSON, "person", {"workload": 0.9, "fatigue": 0.8, "ergonomicRisk": 0.3}),
            _fact("exo:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "exo", {"batteryPct": 12}),
            _fact("machine:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "machine", {"vibrationExceeded": True}),
            _fact("material:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "material", {"inventory": 5, "minThreshold": 10}),
            _fact("station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "station", {"qualityBlocked": True}),
            _fact("alert:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "alert", {"andonRaised": True, "unacknowledgedMinutes": 40}),
        ],
    )
    assert [c["ruleId"] for c in conclusions] == list(rtr.RULE_IDS)
    assert all(c["confidence"] == 1 and c["confidenceBasis"] == "deterministic" for c in conclusions)
    # TEST-014：以 ruleId+severity 结构化断言为主（不绑定中文文案模板，防文案调整脆弱）
    assert [c["severity"] for c in conclusions] == [
        "high",    # rule:worker-overload
        "high",    # rule:exo-low-battery
        "critical",  # rule:machine-vibration-risk
        "high",    # rule:material-shortage
        "critical",  # rule:station-quality-blocked
        "high",    # rule:andon-escalation
    ]
    # explanation 结构存在且非空（契约要求非空字符串），但不锁定具体措辞
    assert all(isinstance(c["explanation"], str) and c["explanation"].strip() for c in conclusions)


def test_evaluate_rules_no_trigger_empty():
    conclusions = rtr.evaluate_rules(
        "rt-py2",
        [
            _fact(PERSON, "person", {"workload": 0.5, "fatigue": 0.2, "ergonomicRisk": 0.1}),
            _fact("alert:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "alert", {"andonRaised": True, "unacknowledgedMinutes": 5}),
        ],
    )
    assert conclusions == []


def test_registries_match_schema():
    import json as _json

    schema = _json.load(open(
        Path(__file__).resolve().parent.parent / "contracts" / "reasoning" / "reasoning-trace.schema.json",
        encoding="utf-8",
    ))
    assert list(rtr.RULE_IDS) == schema["ruleRegistry"]
    assert list(rtr.SEVERITIES) == schema["severityRegistry"]
    assert list(rtr.CONFIDENCE_BASES) == schema["confidenceBasisRegistry"]
    assert list(rtr.FACT_KINDS) == schema["factKindRegistry"]
