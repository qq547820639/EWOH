"""LearningProposal 契约测试（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。

向量仲裁由 scripts/audit-domain-contracts.js（learning_proposal 域）承担；
本文件覆盖 Python 侧向量一致性 + 注册表与 schema 交叉核对 + 关键边界 +
确定性影子评估器（与 TS 端共享 Golden #20 执行向量约束）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edge_platform.contracts import learning_proposal as lp

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "contracts" / "learning" / "learning-proposal.test-vectors.json"
)

with VECTORS_PATH.open("r", encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)["records"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vectors(case):
    errors = lp.validate_learning_proposal(case["record"])
    if case["expectError"] is None:
        assert errors == [], (case["name"], errors)
    else:
        assert errors[0] == case["expectError"], (case["name"], errors)


def test_registries_match_schema():
    schema = json.load(open(
        Path(__file__).resolve().parent.parent
        / "contracts" / "learning" / "learning-proposal.schema.json",
        encoding="utf-8",
    ))
    assert list(lp.KINDS) == schema["kindRegistry"]
    assert list(lp.STATUSES) == schema["statusRegistry"]
    assert [list(pair) for pair in lp.THRESHOLD_RULES] == [
        [t["ruleId"], t["parameter"]] for t in schema["thresholdRules"]
    ]


def test_key_boundaries():
    base = {
        "proposalId": "lp:x:1", "kind": "rule_threshold", "status": "proposed",
        "change": {"ruleId": "rule:worker-overload", "parameter": "workloadThreshold",
                   "baselineValue": 0.8, "candidateValue": 0.75},
        "auditTrail": True,
    }
    assert lp.validate_learning_proposal(base) == []
    assert lp.validate_learning_proposal({**base, "kind": "policy_weight"})[0] == "unknown_kind"
    assert lp.validate_learning_proposal(
        {**base, "change": {**base["change"], "ruleId": "rule:exo-low-battery"}},
    )[0] == "unsupported_threshold"
    assert lp.validate_learning_proposal(
        {**base, "status": "approved", "approvedBy": "person:a", "approvedAt": "2026-08-16T10:00:00Z"},
    )[0] == "shadow_eval_required"
    assert lp.validate_learning_proposal(
        {**base, "change": {**base["change"], "candidateValue": 0.8}},
    )[0] == "no_op_change"
    assert lp.validate_learning_proposal({**base, "auditTrail": False})[0] == "audit_required"


def test_transitions():
    assert lp.proposal_transition_allowed("proposed", "shadow_evaluated")
    assert lp.proposal_transition_allowed("proposed", "rejected")
    assert lp.proposal_transition_allowed("shadow_evaluated", "approved")
    assert lp.proposal_transition_allowed("shadow_evaluated", "rejected")
    assert lp.proposal_transition_allowed("approved", "rolled_back")
    assert not lp.proposal_transition_allowed("proposed", "approved")
    assert not lp.proposal_transition_allowed("rejected", "approved")
    assert not lp.proposal_transition_allowed("rolled_back", "approved")


def test_shadow_evaluator_deterministic():
    facts = [
        {"subjectId": "person:p1", "kind": "person",
         "values": {"workload": 0.82, "fatigue": 0.8, "ergonomicRisk": 0.2}},
        {"subjectId": "person:p2", "kind": "person",
         "values": {"workload": 0.78, "fatigue": 0.75, "ergonomicRisk": 0.1}},
        {"subjectId": "person:p3", "kind": "person",
         "values": {"workload": 0.9, "fatigue": 0.9, "ergonomicRisk": 0.9}},
    ]
    tighten = lp.evaluate_rule_threshold_shadow("rule:worker-overload", 0.8, 0.75, facts)
    assert tighten == {
        "baselineThreshold": 0.8, "candidateThreshold": 0.75, "factsCount": 3,
        "baselineFires": 2, "candidateFires": 3,
        "addedSubjects": ["person:p2"], "removedSubjects": [], "riskLevel": "low",
    }
    loosen = lp.evaluate_rule_threshold_shadow("rule:worker-overload", 0.8, 0.85, facts)
    assert loosen["removedSubjects"] == ["person:p1"]
    assert loosen["riskLevel"] == "medium"
    high = lp.evaluate_rule_threshold_shadow("rule:worker-overload", 0.7, 0.95, facts)
    assert high["riskLevel"] == "high"


def test_shadow_evaluator_fail_closed():
    facts = [
        {"subjectId": "person:p1", "kind": "person",
         "values": {"workload": 0.9, "fatigue": 0.8, "ergonomicRisk": 0.2}},
    ]
    with pytest.raises(ValueError):
        lp.evaluate_rule_threshold_shadow("rule:worker-overload", 0.8, 0.8, facts)
    with pytest.raises(ValueError):
        lp.evaluate_rule_threshold_shadow("rule:worker-overload", 0.8, 0.75, [])
    with pytest.raises(ValueError):
        lp.evaluate_rule_threshold_shadow(
            "rule:worker-overload", 0.8, 0.75,
            [{"subjectId": "machine:m1", "kind": "machine", "values": {}}],
        )
    with pytest.raises(ValueError):
        lp.evaluate_rule_threshold_shadow(
            "rule:worker-overload", 0.8, 0.75,
            [{"subjectId": "person:p1", "kind": "person", "values": {"workload": 0.9}}],
        )


def test_engine_threshold_override_activation():
    """激活面一致性：ReasoningService 应用的覆盖与影子评估器同语义。"""
    from edge_platform.contracts import reasoning_trace as rtr

    facts = [
        {"subjectId": "person:p2", "kind": "person",
         "values": {"workload": 0.78, "fatigue": 0.75, "ergonomicRisk": 0.1},
         "evidenceIds": ["event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"]},
    ]
    baseline = rtr.evaluate_rules("rt-activation", facts)
    assert baseline == []  # workload 0.78 < 0.8 不触发
    activated = rtr.evaluate_rules("rt-activation", facts, thresholds={"workload": 0.75})
    assert len(activated) == 1
    assert activated[0]["ruleId"] == "rule:worker-overload"
    assert activated[0]["subjectId"] == "person:p2"
