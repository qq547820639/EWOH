"""Canonical Risk/Location/Resource 契约测试（ADR-007 / NO-02c）。

- 契约文件合法性（三 schema + 三 vectors）；
- Python 锁定注册表与 schema 逐项一致；
- 共享测试向量全量执行（risk severity/transition/category、location kinds/records、
  resource status/availability/types），与 TS 侧 domain-contracts.spec.ts 消费同一向量；
- TEST-008：agent/agent_task/entity/intelligence/knowledge/reasoning/workorder
  七域 test-vectors.json 的 Python parametrize 消费（此前仅 JS audit 脚本仲裁）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = REPO_ROOT / "contracts"

from edge_platform.contracts import (  # noqa: E402
    agent,
    agent_task,
    entity_model,
    inference_result,
    knowledge,
    reasoning_result,
    risk,
    workorder,
)
from edge_platform.contracts import location as loc  # noqa: E402
from edge_platform.contracts import resource as res  # noqa: E402


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_schema(domain: str) -> dict:
    return _load(CONTRACTS_DIR / domain / f"{domain}.schema.json")


def _load_vectors(domain: str) -> dict:
    return _load(CONTRACTS_DIR / domain / "test-vectors.json")


class TestContractFiles:
    @pytest.mark.parametrize("domain", ["risk", "location", "resource"])
    def test_schema_and_vectors_parse(self, domain):
        schema = _load_schema(domain)
        vectors = _load_vectors(domain)
        assert schema["schemaVersion"] == "1.0.0"
        assert vectors["schemaVersion"] == "1.0.0"
        assert schema["$id"] == "ewoh:///" + domain + "/" + domain + "/v1"

    def test_python_registries_match_schemas(self):
        risk_schema = _load_schema("risk")
        assert risk.SEVERITY_LADDER == tuple(risk_schema["severityLadder"])
        assert risk.LEGACY_SEVERITY_MAP == risk_schema["legacySeverityMap"]
        assert risk.LIFECYCLE == tuple(risk_schema["lifecycle"])
        assert risk.CATEGORIES == frozenset(risk_schema["categoryRegistry"])

        loc_schema = _load_schema("location")
        assert loc.SPATIAL_KINDS == frozenset(loc_schema["spatialKindRegistry"])
        assert loc.COORDINATE_TYPES == frozenset(loc_schema["coordinateTypes"])

        res_schema = _load_schema("resource")
        assert res.STATUSES == frozenset(res_schema["statusRegistry"])
        assert res.DATA_QUALITIES == frozenset(res_schema["dataQualityRegistry"])
        assert res.SOURCES == frozenset(res_schema["sourceRegistry"])
        assert res.RESOURCE_TYPES == frozenset(res_schema["resourceTypeRegistry"])


class TestRiskVectors:
    def test_severity_normalize(self):
        for case in _load_vectors("risk")["severityNormalize"]:
            if "expectError" in case:
                with pytest.raises(risk.DomainContractError) as ei:
                    risk.normalize_severity(case["input"])
                assert ei.value.code == case["expectError"], case
            else:
                assert risk.normalize_severity(case["input"]) == case["expect"], case

    def test_severity_order(self):
        for case in _load_vectors("risk")["severityOrder"]:
            assert risk.severity_higher_than(case["higher"], case["lower"]), case

    def test_transitions(self):
        for case in _load_vectors("risk")["transitions"]:
            assert risk.transition_allowed(case["from"], case["to"]) is case["allowed"], case

    def test_categories(self):
        for case in _load_vectors("risk")["categories"]:
            assert risk.is_valid_category(case["value"]) is case["valid"], case


class TestLocationVectors:
    def test_spatial_kinds(self):
        for case in _load_vectors("location")["spatialKinds"]:
            assert loc.is_valid_spatial_kind(case["value"]) is case["valid"], case

    def test_records(self):
        for case in _load_vectors("location")["records"]:
            errors = loc.validate_location_record(case["record"])
            if case["expectError"] is None:
                assert errors == [], (case["name"], errors)
            else:
                assert case["expectError"] in errors, (case["name"], errors)


class TestResourceVectors:
    def test_statuses(self):
        for case in _load_vectors("resource")["statuses"]:
            assert res.is_valid_status(case["value"]) is case["valid"], case

    def test_availability(self):
        for case in _load_vectors("resource")["availability"]:
            if "expectError" in case:
                with pytest.raises(res.DomainContractError) as ei:
                    res.evaluate_availability(case["status"], case["dataQuality"])
                assert ei.value.code == case["expectError"], case
            else:
                assert res.evaluate_availability(case["status"], case["dataQuality"]) == case["expect"], case

    def test_resource_types(self):
        for case in _load_vectors("resource")["resourceTypes"]:
            assert res.is_valid_resource_type(case["value"]) is case["valid"], case


# ============================================================================
# TEST-008：七域共享向量的 Python parametrize 消费
# （agent/agent_task/entity/intelligence/knowledge/reasoning/workorder 的
#  test-vectors.json 此前仅由 scripts/audit-domain-contracts.js JS 侧仲裁）
# ============================================================================

_VECTOR_DOMAINS = {
    "agent": lambda r: agent.validate_agent_manifest(r),
    "agent_task": lambda r: agent_task.validate_agent_task(r, agent.AGENT_ROLES),
    "entity": lambda r: entity_model.validate_entity_declaration(r),
    "intelligence": lambda r: inference_result.validate_inference_result(r),
    "knowledge": lambda r: knowledge.validate_knowledge_entry(r),
    "reasoning": lambda r: reasoning_result.validate_reasoning_result(r),
    "workorder": lambda r: workorder.validate_work_order(r),
}


def _record_vector_cases():
    cases = []
    for domain in sorted(_VECTOR_DOMAINS):
        for case in _load_vectors(domain)["records"]:
            cases.append(pytest.param(domain, case, id=f"{domain}:{case['name']}"))
    return cases


class TestSharedRecordVectors:
    @pytest.mark.parametrize("domain,case", _record_vector_cases())
    def test_record_vector(self, domain, case):
        errors = _VECTOR_DOMAINS[domain](case["record"])
        if case.get("expectError") is None:
            assert errors == [], (case["name"], errors)
        else:
            assert errors[0] == case["expectError"], (case["name"], errors)

    @pytest.mark.parametrize("domain", sorted(_VECTOR_DOMAINS))
    def test_vectors_nonempty(self, domain):
        records = _load_vectors(domain)["records"]
        assert len(records) > 0
        assert all("name" in r and "record" in r for r in records)
