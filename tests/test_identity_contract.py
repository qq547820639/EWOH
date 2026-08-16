"""Canonical Identity 契约测试（ADR-006 / Phase 2 NO-02）。

- 契约文件自身合法性（identity.schema.json / identity-mapping.schema.json / test-vectors.json）；
- Python 锁定注册表与 schema.kindRegistry 逐项一致；
- 共享测试向量（contracts/identity/test-vectors.json）全量执行：
  valid 必须 parse 成功且 round-trip 稳定；invalid 必须拒绝；
  mapping 场景的解析结果/错误与向量声明的 expect/expectError 逐项一致。
- TS 侧由 ewoh-spark-app/shared/identity.spec.ts 消费同一向量文件（跨语言一致性）。

零第三方依赖：仅标准库 + pytest 测试框架。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
IDENTITY_SCHEMA_PATH = REPO_ROOT / "contracts" / "identity" / "identity.schema.json"
MAPPING_SCHEMA_PATH = REPO_ROOT / "contracts" / "identity" / "identity-mapping.schema.json"
VECTORS_PATH = REPO_ROOT / "contracts" / "identity" / "test-vectors.json"

from edge_platform.contracts import identity as identity_mod  # noqa: E402


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


class TestIdentityContractFiles:
    def test_schema_files_exist_and_parse(self):
        schema = _load_json(IDENTITY_SCHEMA_PATH)
        mapping_schema = _load_json(MAPPING_SCHEMA_PATH)
        vectors = _load_json(VECTORS_PATH)
        assert schema["schemaVersion"] == "1.0.0"
        assert schema["$id"] == "ewoh:///identity/identity/v1"
        assert mapping_schema["$id"] == "ewoh:///identity/identity-mapping/v1"
        assert vectors["schemaVersion"] == "1.0.0"

    def test_schema_registry_is_closed_and_wellformed(self):
        schema = _load_json(IDENTITY_SCHEMA_PATH)
        registry = schema["kindRegistry"]
        assert isinstance(registry, list) and len(registry) == len(set(registry)) > 0
        kind_pattern = schema["kindPattern"]
        value_pattern = schema["valuePattern"]
        for kind in registry:
            assert identity_mod.KIND_PATTERN.fullmatch(kind), f"registry kind 语法非法: {kind}"
        assert kind_pattern == identity_mod.KIND_PATTERN.pattern
        assert value_pattern == identity_mod.VALUE_PATTERN.pattern

    def test_python_registry_matches_schema_exactly(self):
        schema = _load_json(IDENTITY_SCHEMA_PATH)
        assert identity_mod.KINDS == frozenset(schema["kindRegistry"])

    def test_vector_invalid_values_really_parse_as_invalid(self):
        # 向量自检：invalid 列表中的每一项在契约语法下都必须拒绝（防测试腐化）。
        schema = _load_json(IDENTITY_SCHEMA_PATH)
        allowed_kinds = "|".join(re.escape(k) for k in schema["kindRegistry"])
        canonical = identity_mod.re.compile(
            f"^({allowed_kinds}):{schema['valuePattern'].lstrip('^').rstrip('$')}$"
        )
        vectors = _load_json(VECTORS_PATH)
        for entry in vectors["invalid"]:
            assert not canonical.fullmatch(entry["value"]), f"向量标为 invalid 但语法上合法: {entry}"
        for value in vectors["valid"]:
            assert canonical.fullmatch(value), f"向量标为 valid 但语法上非法: {value}"


class TestParseFormat:
    def test_parse_returns_kind_and_value(self):
        assert identity_mod.parse_identity("person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11") == (
            "person",
            "9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11",
        )
        assert identity_mod.parse_identity("exo:NY-A1-SN-0007") == ("exo", "NY-A1-SN-0007")

    def test_format_roundtrip(self):
        canonical = identity_mod.format_identity("task", "t-42")
        assert canonical == "task:t-42"
        assert identity_mod.kind_of(canonical) == "task"
        assert identity_mod.value_of(canonical) == "t-42"

    def test_format_rejects_bad_input(self):
        with pytest.raises(identity_mod.IdentityError) as ei:
            identity_mod.format_identity("unknownkind", "x")
        assert ei.value.code == "unknown_kind"
        with pytest.raises(identity_mod.IdentityError) as ei:
            identity_mod.format_identity("person", "a/b")
        assert ei.value.code == "bad_value"

    def test_parse_fails_closed_variants(self):
        for bad, code in [
            ("", "bad_canonical_form"),
            (":x", "unknown_kind"),
            ("person:", "bad_value"),
            ("person:a:b", "bad_canonical_form"),
            ("Person:x", "unknown_kind"),
            ("person:x%20y", "bad_value"),
            (123, "not_a_string"),
        ]:
            with pytest.raises(identity_mod.IdentityError) as ei:
                identity_mod.parse_identity(bad)
            assert ei.value.code == code, f"{bad!r} → {ei.value.code}，期望 {code}"

    def test_is_canonical_identity_never_raises(self):
        assert identity_mod.is_canonical_identity("factory:f1")
        assert not identity_mod.is_canonical_identity("nope")
        assert not identity_mod.is_canonical_identity(None)


class TestSharedVectors:
    def test_valid_vectors_all_parse(self):
        vectors = _load_json(VECTORS_PATH)
        for value in vectors["valid"]:
            kind, v = identity_mod.parse_identity(value)
            assert value == identity_mod.format_identity(kind, v)  # round-trip 稳定

    def test_invalid_vectors_all_rejected(self):
        vectors = _load_json(VECTORS_PATH)
        for entry in vectors["invalid"]:
            assert not identity_mod.is_canonical_identity(entry["value"]), f"应拒绝: {entry}"

    def test_mapping_scenarios_match_declared_expectations(self):
        vectors = _load_json(VECTORS_PATH)
        for scenario in vectors["mappingScenarios"]:
            expect = scenario["expect"]
            expect_error = scenario["expectError"]
            if expect_error:
                with pytest.raises(identity_mod.IdentityConflictError) as ei:
                    identity_mod.resolve_identity_mapping(
                        scenario["system"],
                        scenario["sourceId"],
                        scenario["mappings"],
                        now=scenario["now"],
                    )
                assert ei.value.code == expect_error, scenario["name"]
            else:
                result = identity_mod.resolve_identity_mapping(
                    scenario["system"],
                    scenario["sourceId"],
                    scenario["mappings"],
                    now=scenario["now"],
                )
                assert result == expect, scenario["name"]


class TestMappingRecordValidation:
    def test_valid_record_has_no_errors(self):
        record = {
            "mappingId": "map:m1",
            "version": 1,
            "source": {"system": "mes", "id": "WO-1001"},
            "target": {"entityId": "order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"},
            "authority": "registration",
            "status": "active",
            "recordedAt": "2026-08-14T08:00:00Z",
            "validFrom": None,
            "validTo": None,
            "evidenceId": None,
        }
        assert identity_mod.validate_mapping_record(record) == []

    def test_malformed_records_report_errors(self):
        assert "missing_field:target" in identity_mod.validate_mapping_record(
            {"mappingId": "map:x", "version": 1}
        )
        bad_target = {
            "mappingId": "map:m1",
            "version": 1,
            "source": {"system": "mes", "id": "WO-1"},
            "target": {"entityId": "not-canonical"},
            "authority": "registration",
            "status": "active",
            "recordedAt": "2026-08-14T08:00:00Z",
        }
        assert "bad_target_entity_id" in identity_mod.validate_mapping_record(bad_target)
        bad_status = dict(bad_target, status="weird")
        assert "bad_status" in identity_mod.validate_mapping_record(bad_status)

    def test_non_dict_record_reports_error(self):
        assert identity_mod.validate_mapping_record("not-a-dict") == ["record_must_be_object"]


class TestMappingSemantics:
    def test_idempotent_duplicate_active_same_target(self):
        mapping = {
            "mappingId": "map:m1",
            "version": 1,
            "source": {"system": "mes", "id": "WO-1"},
            "target": {"entityId": "order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"},
            "authority": "registration",
            "status": "active",
            "recordedAt": "2026-08-14T08:00:00Z",
            "validFrom": None,
            "validTo": None,
            "evidenceId": None,
        }
        dup = dict(mapping, mappingId="map:m2")
        result = identity_mod.resolve_identity_mapping("mes", "WO-1", [mapping, dup], now="2026-08-14T10:00:00Z")
        assert result == "order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"

    def test_conflict_fails_closed(self):
        base = {
            "version": 1,
            "source": {"system": "mes", "id": "WO-1"},
            "target": {"entityId": "order:00000000-0000-4000-8000-000000000001"},
            "authority": "registration",
            "status": "active",
            "recordedAt": "2026-08-14T08:00:00Z",
            "validFrom": None,
            "validTo": None,
            "evidenceId": None,
        }
        other = dict(base, mappingId="map:m2", target={"entityId": "order:00000000-0000-4000-8000-000000000002"})
        with pytest.raises(identity_mod.IdentityConflictError):
            identity_mod.resolve_identity_mapping("mes", "WO-1", [base, other], now="2026-08-14T10:00:00Z")

    def test_malformed_records_are_skipped_not_trusted(self):
        # 形状非法的记录不得参与解析（fail-closed：不因脏数据误映射）
        result = identity_mod.resolve_identity_mapping("mes", "WO-1", [{"junk": True}])
        assert result is None
