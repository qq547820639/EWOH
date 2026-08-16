"""Canonical Factory World State Contract（ADR-008 / NO-03）。

权威契约：contracts/world/world-state.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js world 域仲裁强制。

语义：
- StateRecord：双时态 [valid_from, valid_to) + sourceType（real/simulated/derived）+
  confidence [0,1] + version；entityId 必须是规范身份（复用 identity 契约）；
- 版本单调：同键新状态 version = 旧 + 1；区间不重叠（set() 语义）；
- 模拟隔离：simulated 绝不参与 real 判定（§13）；
- fail-closed：未知 entityType/身份非法/confidence 越界 → 拒绝。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

ENTITY_TYPES: frozenset = frozenset(
    {
        "person",
        "exo",
        "machine",
        "robot",
        "agv",
        "tool",
        "material",
        "container",
        "inventory",
        "order",
        "operation",
        "work_instruction",
        "task",
        "station",
        "zone",
        "route",
        "factory",
        "warehouse",
        "sensor",
        "event",
        "risk",
        "knowledge",
    }
)
SOURCE_TYPES: frozenset = frozenset({"real", "simulated", "derived"})

_REQUIRED_STATE_FIELDS = (
    "stateId", "entityId", "entityType", "stateJson",
    "validFrom", "sourceType", "confidence", "version",
)


def _parse_ts(value: Any):
    """ISO 8601 → 毫秒（容忍 Z）；非法返回 None。与 identity._parse_iso 同语义。"""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    from datetime import datetime, timezone

    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def validate_state_record(record: Any) -> list[str]:
    """校验 StateRecord；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_STATE_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["stateId"], str) or not record["stateId"]:
        return ["bad_state_id"]
    if not isinstance(record["entityId"], str) or not is_canonical_identity(record["entityId"]):
        return ["bad_entity_id"]
    if record["entityType"] not in ENTITY_TYPES:
        return ["unknown_entity_type"]
    if not isinstance(record["stateJson"], dict):
        return ["bad_state_json"]
    if record["sourceType"] not in SOURCE_TYPES:
        return ["unknown_source_type"]
    confidence = record["confidence"]
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not (0.0 <= confidence <= 1.0):
        return ["bad_confidence"]
    version = record["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return ["bad_version"]
    valid_from = _parse_ts(record["validFrom"])
    if valid_from is None:
        return ["bad_valid_from"]
    valid_to = record.get("validTo")
    if valid_to is not None:
        vt = _parse_ts(valid_to)
        if vt is None or vt < valid_from:
            return ["bad_interval"]
    return []


def validate_interval_set(records: list[dict]) -> list[str]:
    """同 (entityId, stateType) 区间集合校验：不重叠 + 版本单调。返回错误码列表。"""
    groups: dict[tuple, list[dict]] = {}
    for r in records:
        if not isinstance(r, dict):
            return ["record_must_be_object"]
        key = (r.get("entityId"), r.get("stateType"))
        groups.setdefault(key, []).append(r)
    for group in groups.values():
        ordered = sorted(group, key=lambda r: _parse_ts(r.get("validFrom")) or float("inf"))
        prev_end = None
        prev_version = 0
        first = True
        for r in ordered:
            vf = _parse_ts(r.get("validFrom"))
            vt = _parse_ts(r.get("validTo"))
            if vf is None:
                return ["bad_valid_from"]
            if prev_end is not None and vf < prev_end:
                return ["overlapping_interval"]
            version = r.get("version")
            # 快照可只含当前记录（版本单调性只在同键多记录时校验：从 1 起连续递增）
            if not first and (not isinstance(version, int) or version != prev_version + 1):
                return ["version_not_monotonic"]
            first = False
            prev_version = version
            prev_end = vt
    return []


def validate_snapshot(snapshot: Any) -> list[str]:
    """校验 Snapshot：字段 + entityVersions 键为规范身份 + states 合法 + 区间集合。"""
    if not isinstance(snapshot, dict):
        return ["record_must_be_object"]
    for field in ("snapshotId", "snapshotVersion", "ts", "worldVersion", "entityVersions", "states"):
        if field not in snapshot:
            return [f"missing_field:{field}"]
    if not isinstance(snapshot["worldVersion"], int) or snapshot["worldVersion"] < 0:
        return ["bad_world_version"]
    entity_versions = snapshot["entityVersions"]
    if not isinstance(entity_versions, dict):
        return ["bad_entity_versions"]
    for key, version in entity_versions.items():
        if not isinstance(key, str) or not is_canonical_identity(key):
            return ["bad_entity_version_key"]
        if not isinstance(version, int) or version < 0:
            return ["bad_entity_version_value"]
    states = snapshot["states"]
    if not isinstance(states, list):
        return ["bad_states"]
    errors: list[str] = []
    for s in states:
        record_errors = validate_state_record(s)
        if record_errors:
            errors.append(record_errors[0])
    errors.extend(validate_interval_set(states))
    return errors


def snapshot_source_profile(states: list[dict]) -> dict[str, bool]:
    """来源画像：simulatedOnly / hasReal（契约规则 3 的机器可执行面）。"""
    sources = {s.get("sourceType") for s in states if isinstance(s, dict)}
    return {
        "simulatedOnly": bool(sources) and sources == {"simulated"},
        "hasReal": "real" in sources,
    }
