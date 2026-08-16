"""Canonical Contract Golden Scenarios（总提示词 §26；ADR-006/ADR-007）。

从 tests/golden-fixtures/contract-golden-scenarios.json 加载四个 Golden 场景
（身份映射冲突 / legacy 严重度归一 / 脏空间类型拒绝 / 资源新鲜度 fail-closed），
逐 case 执行并断言；TS 侧 golden-contract-scenarios.spec.ts 消费同一份定义，
保证跨语言场景语义一致。契约或接线变更必须重跑（make contract-golden + CI）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SCENARIOS_PATH = REPO_ROOT / "tests" / "golden-fixtures" / "contract-golden-scenarios.json"

from edge_platform.contracts import agent as agent_mod  # noqa: E402
from edge_platform.contracts import capability as cap_mod  # noqa: E402
from edge_platform.contracts import agent_task as agent_task_mod  # noqa: E402
from edge_platform.contracts import dead_letter as dead_mod  # noqa: E402
from edge_platform.contracts import decision as dec  # noqa: E402
from edge_platform.contracts import entity_model as ent  # noqa: E402
from edge_platform.contracts import envelope as env  # noqa: E402
from edge_platform.contracts import exo_session as exo  # noqa: E402
from edge_platform.contracts import exo_config as exc  # noqa: E402
from edge_platform.contracts import identity as identity_mod  # noqa: E402
from edge_platform.contracts import inference_result as intel  # noqa: E402
from edge_platform.contracts import knowledge as knowledge_mod  # noqa: E402
from edge_platform.contracts import learning_evaluation as learn  # noqa: E402
from edge_platform.contracts import learning_proposal as lpro  # noqa: E402
from edge_platform.contracts import location as loc  # noqa: E402
from edge_platform.contracts import maintenance as maint  # noqa: E402
from edge_platform.contracts import metrics_registry as metrics_mod  # noqa: E402
from edge_platform.contracts import outcome_annotation as oa  # noqa: E402
from edge_platform.contracts import quality as qual  # noqa: E402
from edge_platform.contracts import reasoning_result as reason  # noqa: E402
from edge_platform.contracts import reasoning_trace as rtr  # noqa: E402
from edge_platform.contracts import resource as res  # noqa: E402
from edge_platform.contracts import risk  # noqa: E402
from edge_platform.contracts import simulation_run as sim  # noqa: E402
from edge_platform.contracts import workorder as wo  # noqa: E402
from edge_platform.contracts import world as wm  # noqa: E402


def _load() -> dict:
    with SCENARIOS_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _run_case(domain: str, case: dict):
    if domain == "identity":
        if case["expectError"] is not None:
            with pytest.raises(identity_mod.IdentityConflictError) as ei:
                identity_mod.resolve_identity_mapping(
                    case["system"], case["sourceId"], case["mappings"], now=case["now"]
                )
            assert ei.value.code == case["expectError"], case["name"]
        else:
            result = identity_mod.resolve_identity_mapping(
                case["system"], case["sourceId"], case["mappings"], now=case["now"]
            )
            assert result == case["expect"], case["name"]
    elif domain == "risk":
        if "input" in case:
            if case["expectError"] is not None:
                with pytest.raises(risk.DomainContractError) as ei:
                    risk.normalize_severity(case["input"])
                assert ei.value.code == case["expectError"], case["name"]
            else:
                assert risk.normalize_severity(case["input"]) == case["expect"], case["name"]
        else:
            assert risk.transition_allowed(case["from"], case["to"]) is case["allowed"], case["name"]
    elif domain == "location":
        if "kind" in case:
            assert loc.is_valid_spatial_kind(case["kind"]) is case["valid"], case["name"]
        else:
            errors = loc.validate_location_record(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert case["expectError"] in errors, (case["name"], errors)
    elif domain == "resource":
        if case["expectError"] is not None:
            with pytest.raises(res.DomainContractError) as ei:
                res.evaluate_availability(case["status"], case["dataQuality"])
            assert ei.value.code == case["expectError"], case["name"]
        else:
            assert res.evaluate_availability(case["status"], case["dataQuality"]) == case["expect"], case["name"]
    elif domain == "world":
        if "states" in case:
            records = [
                {
                    "entityId": "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11",
                    "stateType": "location",
                    "validFrom": st["validFrom"],
                    "validTo": st["validTo"],
                    "version": st["version"],
                }
                for st in case["states"]
            ]
            errors = wm.validate_interval_set(records)
            assert case["expectError"] in errors, (case["name"], errors)
        else:
            errors = wm.validate_state_record(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
                if "expectProfile" in case:
                    assert wm.snapshot_source_profile([case["record"]]) == case["expectProfile"], case["name"]
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "envelope":
        with (REPO_ROOT / "contracts" / "events" / "event-catalog.yaml").open("r", encoding="utf-8") as fh:
            known = frozenset(yaml.safe_load(fh)["x-event-types"])
        if "dedupKey" in case:
            assert env.dedup_key(case["envelope"]) == tuple(case["dedupKey"]), case["name"]
            return
        errors = env.validate_envelope(case["envelope"], known)
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
            if case.get("expect") is not None:
                assert env.envelope_semantics(case["envelope"]) == case["expect"], case["name"]
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "maintenance_quality":
        if "condition" in case:
            record = case["condition"]
            if case.get("expectError") is not None:
                errors = maint.validate_condition(record)
                assert errors[0] == case["expectError"], (case["name"], errors)
            else:
                assert maint.validate_condition(record) == [], case["name"]
        elif "path" in case:
            path = case["path"]
            ok = all(maint.transition_allowed(path[i], path[i + 1]) for i in range(len(path) - 1))
            assert ok is case["expectValid"], case["name"]
        elif "dueAt" in case:
            assert maint.is_overdue(case["dueAt"], case["status"], case["now"]) is case["expectOverdue"], case["name"]
        elif "finding" in case:
            errors = qual.validate_finding(case["finding"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
        else:
            raise AssertionError(f"unhandled case: {case['name']}")
    elif domain == "workorder":
        if "path" in case:
            path = case["path"]
            ok = all(wo.transition_allowed(path[i], path[i + 1]) for i in range(len(path) - 1))
            assert ok is case["expectValid"], case["name"]
        else:
            errors = wo.validate_work_order(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "intelligence":
        errors = intel.validate_inference_result(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "reasoning":
        errors = reason.validate_reasoning_result(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "reasoning_trace":
        if "record" in case:
            errors = rtr.validate_reasoning_trace(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
        else:
            conclusions = rtr.evaluate_rules(case["input"]["traceId"], case["input"]["facts"])
            assert conclusions == case["expect"], case["name"]
    elif domain == "entity":
        errors = ent.validate_entity_declaration(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "agent":
        errors = agent_mod.validate_agent_manifest(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "agent_task":
        errors = agent_task_mod.validate_agent_task(case["record"], agent_mod.AGENT_ROLES)
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "knowledge":
        errors = knowledge_mod.validate_knowledge_entry(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "learning":
        errors = learn.validate_learning_evaluation(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "metrics":
        errors = metrics_mod.validate_metric_sample(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "dead_letter":
        errors = dead_mod.validate_dead_letter(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "simulation":
        if "record" in case:
            errors = sim.validate_simulation_run(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
        else:
            engine = case["input"]["engine"]
            if engine == "capacity":
                result = sim.evaluate_capacity(case["input"]["stations"], case["input"]["demandPerHour"])
            elif engine == "layout":
                result = sim.evaluate_layout(case["input"]["stations"], case["input"]["moves"])
            elif engine == "material_flow":
                result = sim.evaluate_material_flow(case["input"]["stations"])
            elif engine == "what_if":
                result = sim.evaluate_what_if(
                    case["input"]["traceId"],
                    case["input"]["baseFacts"],
                    case["input"]["deltaFacts"],
                )
            else:
                raise AssertionError(f"unknown simulation engine {engine}")
            assert result == case["expect"], case["name"]
    elif domain == "learning_proposal":
        if "record" in case:
            errors = lpro.validate_learning_proposal(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
        else:
            engine = case["input"]["engine"]
            if engine == "shadow":
                result = lpro.evaluate_rule_threshold_shadow(
                    case["input"]["ruleId"],
                    case["input"]["baselineThreshold"],
                    case["input"]["candidateThreshold"],
                    case["input"]["facts"],
                )
            elif engine == "transition":
                result = [
                    lpro.proposal_transition_allowed(from_s, to_s)
                    for from_s, to_s in case["input"]["pairs"]
                ]
            else:
                raise AssertionError(f"unknown learning_proposal engine {engine}")
            assert result == case["expect"], case["name"]
    elif domain == "capability":
        errors = cap_mod.validate_capability(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "decision":
        errors = dec.validate_decision(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "exo_config":
        errors = exc.validate_exo_config(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "outcome_annotation":
        errors = oa.validate_outcome_annotation(case["record"])
        if case["expectError"] is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)
    elif domain == "exo_session":
        if "record" in case:
            errors = exo.validate_exo_session(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert errors[0] == case["expectError"], (case["name"], errors)
        else:
            result = [
                exo.exo_session_transition_allowed(from_s, to_s)
                for from_s, to_s in case["input"]["pairs"]
            ]
            assert result == case["expect"], case["name"]
    else:
        raise AssertionError(f"unknown domain {domain}")


class TestGoldenContractScenarios:
    def test_all_scenarios_declared_domains_covered(self):
        data = _load()
        assert {s["id"] for s in data["scenarios"]} == {
            "identity_mapping_conflict",
            "legacy_severity_normalization",
            "dirty_spatial_type_rejection",
            "resource_freshness_fail_closed",
            "world_state_projection_rules",
            "event_envelope_semantics",
            "maintenance_quality_loop",
            "workorder_loop",
            "inference_result_contract",
            "reasoning_result_contract",
            "reasoning_trace_contract",
            "entity_model_contract",
            "agent_manifest_contract",
            "agent_task_contract",
            "knowledge_entry_contract",
            "learning_evaluation_contract",
            "metrics_registry_contract",
            "dead_letter_contract",
            "simulation_run_contract",
            "learning_proposal_contract",
            "exo_session_contract",
            "outcome_annotation_contract",
            "capability_contract",
            "decision_contract",
            "exo_config_contract",
        }

    def test_scenario(self):
        scenarios = _load()["scenarios"]
        for scenario in scenarios:
            for case in scenario["cases"]:
                _run_case(scenario["domain"], case)
