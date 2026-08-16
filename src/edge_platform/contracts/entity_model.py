"""Canonical Factory Entity Model（统一工厂实体模型契约，ADR-015 / NO-03a）。

权威契约：contracts/entity/entity-model.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制
（含 world-state 22 类快照实体 ⊆ 本注册表交叉校验）。

语义：
- entityKindRegistry = §4 实体清单 45 类封闭注册表；
- 实体声明：entityId 规范身份（ADR-006）、kind ∈ 注册表、tenantId/factoryId
  必填、timeSemantics 双时态（validFrom 必填 ISO、validTo 不得早于）、
  status 非空、source ∈ {real, simulated, derived}（模拟显式标记）、
  version ≥ 1、confidence 可选 ∈ [0,1]（缺省无标定不得伪装）、
  refs/eventRefs 规范身份数组。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

# ---GEN-BEGIN:entity-registries---
# 自动生成（scripts/gen-contract-registries.js --write）；权威源 contracts/entity/entity-model.schema.json。
# 请勿手改本生成区；漂移由 make truth-check 的 gen-contract-registries --check 拦截，
# audit-domain-contracts.js 独立仲裁为双保险。

ENTITY_KINDS: tuple[str, ...] = ("person", "worker_capability", "skill",
    "certification", "fatigue", "workload", "ergonomic_risk", "exo",
    "machine", "robot", "agv", "tool", "material", "container", "inventory",
    "order", "production_order", "operation", "task", "work_instruction",
    "station", "zone", "route", "factory", "warehouse", "sensor",
    "observation", "event", "alert", "incident", "risk", "quality_finding",
    "maintenance_condition", "reservation", "assignment", "plan",
    "decision", "approval", "execution", "outcome", "policy", "constraint",
    "model", "agent", "knowledge",)

SOURCES: frozenset = frozenset({"real", "simulated", "derived"})

WORLD_STATE_PROJECTABLE_KINDS: tuple[str, ...] = ("person", "exo",
    "machine", "robot", "agv", "tool", "material", "container", "inventory",
    "order", "operation", "work_instruction", "task", "station", "zone",
    "route", "factory", "warehouse", "sensor", "event", "risk", "knowledge",)

PERSON_BUCKET_KINDS: tuple[str, ...] = ("person",)

DEVICE_BUCKET_KINDS: tuple[str, ...] = ("device", "exo", "machine", "robot", "agv", "sensor",)

STATION_BUCKET_KINDS: tuple[str, ...] = ("station",)

TASK_BUCKET_KINDS: tuple[str, ...] = ("task",)
# ---GEN-END:entity-registries---

# ── 权威投影分工（ADR-015，schema projectionDivision / projectionBuckets 锁定）──
# 可观察状态投影 = world-state 契约 22 类注册表（生成区 WORLD_STATE_PROJECTABLE_KINDS
# 由 schema projectionDivision.stateProjectableKinds 生成，门禁交叉强制）；
# 云侧粗粒度投影桶（person/device/station/task）→ 实体 kind 的显式映射
# （device 桶 = 遗留身份桶 device + 设备类实体 kind exo/machine/robot/agv/sensor）。
_PROJECTABLE_KINDS: frozenset = frozenset(WORLD_STATE_PROJECTABLE_KINDS)


def is_state_projectable(kind: Any) -> bool:
    """kind 是否属于可观察状态投影（world-state 22 类）；其余为声明型实体。"""
    return kind in _PROJECTABLE_KINDS


def parse_iso(value: Any):
    """ISO 时间解析（毫秒，解析失败返回 None）——供声明时间比较复用。"""
    from .envelope import parse_ts

    return parse_ts(value) if isinstance(value, str) else None


def validate_entity_declaration(record: Any) -> list[str]:
    """校验实体声明；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in ("entityId", "kind", "tenantId", "factoryId", "timeSemantics", "status", "source", "version"):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["entityId"], str) or not is_canonical_identity(record["entityId"]):
        return ["bad_entity_id"]
    if record["kind"] not in ENTITY_KINDS:
        return ["unknown_kind"]
    # kind 前缀一致性：kind:value 的 kind 部分即实体类别；身份专属 kind（device/session）
    # 不得承载实体声明（kind_prefix_unknown），实体 kind 前缀与声明 kind 不一致拒绝。
    prefix = record["entityId"].split(":", 1)[0]
    if prefix not in ENTITY_KINDS:
        return ["kind_prefix_unknown"]
    if prefix != record["kind"]:
        return ["kind_prefix_mismatch"]
    if not isinstance(record["tenantId"], str) or not record["tenantId"]:
        return ["bad_tenant"]
    if not isinstance(record["factoryId"], str) or not record["factoryId"]:
        return ["bad_factory"]
    time_sem = record["timeSemantics"]
    if not isinstance(time_sem, dict) or "validFrom" not in time_sem:
        return ["bad_time"]
    valid_from = parse_iso(time_sem["validFrom"])
    if valid_from is None:
        return ["bad_time"]
    valid_to = time_sem.get("validTo")
    if valid_to is not None:
        valid_to_ms = parse_iso(valid_to)
        if valid_to_ms is None:
            return ["bad_time"]
        if valid_to_ms < valid_from:
            return ["bad_time"]
    if not isinstance(record["status"], str) or not record["status"]:
        return ["bad_status"]
    if record["source"] not in SOURCES:
        return ["unknown_source"]
    version = record["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return ["bad_version"]
    confidence = record.get("confidence")
    if confidence is not None and (
        not isinstance(confidence, (int, float))
        or isinstance(confidence, bool)
        or confidence < 0
        or confidence > 1
    ):
        return ["bad_confidence"]
    for key in ("refs", "eventRefs"):
        refs = record.get(key)
        if refs is None:
            continue
        if not isinstance(refs, list) or any(
            not isinstance(r, str) or not is_canonical_identity(r) for r in refs
        ):
            return ["bad_ref"]
    return []
