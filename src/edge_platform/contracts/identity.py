"""Canonical Industrial Identity（统一工业身份，ADR-006 / Phase 2 NO-02）。

权威契约：contracts/identity/identity.schema.json（kind 注册表 + 语法 + 规则）与
contracts/identity/test-vectors.json（跨语言一致性向量）。本模块是边缘运行时的
**锁定实现**：KINDS 注册表必须与 schema.kindRegistry 一致，由
scripts/audit-identity-contracts.js 门禁强制（CI + make truth-check）。

设计不变量（与 ADR-006 一致）：
- 规范形式 ``kind:value``，恰好一个冒号，字节相等即身份相等，大小写敏感；
- kind 封闭注册表，未知 kind → 拒绝（fail-closed，禁止猜测）；
- value 由 EWOH 生成（推荐 UUID v4），第三方 ID 仅经 mapping 记录关联为 alias；
- mapping 解析：仅 active 且时间窗口有效者参与；精确匹配 1 条返回；
  ≥2 条抛 IdentityConflictError；0 条返回 None（未映射）。

零第三方依赖（pyproject dependencies=[]）：仅使用 json/re/datetime 标准库。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

# 锁定注册表：与 contracts/identity/identity.schema.json 的 kindRegistry 逐项一致
# （门禁强制；变更必须同步契约并过门禁）。
KINDS: frozenset = frozenset(
    {
        "person",
        "exo",
        "device",
        "machine",
        "robot",
        "agv",
        "tool",
        "material",
        "container",
        "inventory",
        "order",
        "task",
        "operation",
        "work_instruction",
        "station",
        "zone",
        "route",
        "factory",
        "warehouse",
        "sensor",
        "event",
        "alert",
        "incident",
        "risk",
        "quality_finding",
        "maintenance_condition",
        "reservation",
        "assignment",
        "plan",
        "decision",
        "approval",
        "execution",
        "outcome",
        "policy",
        "constraint",
        "model",
        "agent",
        "knowledge",
        "skill",
        "certification",
        "session",
        "observation",
    }
)

KIND_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
VALUE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$")
MAX_VALUE_LENGTH = 128

_MAPPING_STATUSES = frozenset({"active", "superseded", "revoked"})
_MAPPING_AUTHORITIES = frozenset({"registration", "adapter", "manual"})


class IdentityError(ValueError):
    """身份格式/语义错误（fail-closed）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class IdentityConflictError(IdentityError):
    """mapping 解析冲突：同一 (system, id) 存在 ≥2 条 active 且有效的记录。"""

    def __init__(self, system: str, source_id: str, count: int):
        super().__init__(
            "ambiguous_identity",
            f"ambiguous_identity: system={system!r} id={source_id!r} 命中 {count} 条 active 映射，fail-closed",
        )


def parse_identity(identity: str) -> tuple[str, str]:
    """解析规范身份 ``kind:value``，返回 (kind, value)；非法则抛 IdentityError。

    恰好一个冒号；kind 必须命中注册表；value 必须满足语法；无空白；
    禁止 `/`、`%`、非 ASCII。绝不猜测类型（fail-closed）。
    """
    if not isinstance(identity, str):
        raise IdentityError("not_a_string", f"身份必须是字符串，收到 {type(identity).__name__}")
    if identity.count(":") != 1:
        raise IdentityError("bad_canonical_form", f"身份必须为 kind:value 单冒号形式: {identity!r}")
    kind, _, value = identity.partition(":")
    if kind not in KINDS:
        raise IdentityError("unknown_kind", f"kind 不在注册表: {kind!r}")
    if not VALUE_PATTERN.match(value):
        raise IdentityError("bad_value", f"value 语法非法（≤128 字符，禁止 ':' '/' '%' 空白）: {value!r}")
    return kind, value


def format_identity(kind: str, value: str) -> str:
    """按契约组装规范身份；任一字段非法即抛 IdentityError（不静默产出）。"""
    if kind not in KINDS:
        raise IdentityError("unknown_kind", f"kind 不在注册表: {kind!r}")
    if not VALUE_PATTERN.match(value):
        raise IdentityError("bad_value", f"value 语法非法: {value!r}")
    return f"{kind}:{value}"


def is_canonical_identity(candidate: str) -> bool:
    """candidate 是否为合法规范身份（不抛异常）。"""
    try:
        parse_identity(candidate)
        return True
    except IdentityError:
        return False


def kind_of(identity: str) -> str:
    return parse_identity(identity)[0]


def value_of(identity: str) -> str:
    return parse_identity(identity)[1]


def _parse_iso(value: str | None) -> datetime | None:
    """解析 ISO8601（容忍 'Z'；Python ≥3.9 无 fromisoformat('Z')）。非法返回 None。"""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def resolve_identity_mapping(
    system: str,
    source_id: str,
    mappings: Iterable[dict],
    now: str | None = None,
) -> str | None:
    """按契约解析第三方 (system, id) → 规范身份。

    规则（ADR-006）：仅 status==active 且 validFrom ≤ now < validTo 的记录参与；
    精确匹配 (source.system, source.id)；恰好 1 条返回 target.entityId；
    ≥2 条抛 IdentityConflictError；0 条返回 None（未映射，调用方 fail-closed 拒绝）。
    """
    now_dt = _parse_iso(now)
    hits: list[str] = []
    for record in mappings:
        try:
            source = record["source"]
            status = record.get("status")
            target_entity = record["target"]["entityId"]
        except (KeyError, TypeError):
            # 形状非法的记录不参与解析（由 validate_mapping_record 负责报错）
            continue
        if status != "active":
            continue
        if source.get("system") != system or source.get("id") != source_id:
            continue
        if now_dt is not None:
            valid_from = _parse_iso(record.get("validFrom"))
            valid_to = _parse_iso(record.get("validTo"))
            if valid_from is not None and now_dt < valid_from:
                continue
            if valid_to is not None and now_dt >= valid_to:
                continue
        hits.append(target_entity)
    unique = list(dict.fromkeys(hits))
    if len(unique) > 1:
        raise IdentityConflictError(system, source_id, len(unique))
    return unique[0] if unique else None


_MAPPING_REQUIRED_FIELDS = ("mappingId", "version", "source", "target", "authority", "status", "recordedAt")


def validate_mapping_record(record: Any) -> list[str]:
    """校验 identity-mapping 记录语义（纯标准库，等价 identity-mapping.schema.json 子集）。

    返回错误列表；空列表 = 合法。不做 jsonschema 依赖。
    """
    errors: list[str] = []
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _MAPPING_REQUIRED_FIELDS:
        if field not in record:
            errors.append(f"missing_field:{field}")
    if errors:
        return errors

    mapping_id = record.get("mappingId")
    if not isinstance(mapping_id, str) or not re.match(
        r"^map:[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$", mapping_id
    ):
        errors.append("bad_mapping_id")
    # R2-SHR-007：bool 不是版本号（对齐 TS Number.isInteger(true)===false）。
    if (
        not isinstance(record.get("version"), int)
        or isinstance(record.get("version"), bool)
        or record["version"] < 1
    ):
        errors.append("bad_version")
    if record.get("status") not in _MAPPING_STATUSES:
        errors.append("bad_status")
    if record.get("authority") not in _MAPPING_AUTHORITIES:
        errors.append("bad_authority")

    source = record.get("source")
    if not isinstance(source, dict):
        errors.append("bad_source")
    else:
        system = source.get("system")
        source_id = source.get("id")
        if not isinstance(system, str) or not (1 <= len(system) <= 64):
            errors.append("bad_source_system")
        if not isinstance(source_id, str) or not (1 <= len(source_id) <= 255):
            errors.append("bad_source_id")

    target = record.get("target")
    if not isinstance(target, dict):
        errors.append("bad_target")
    else:
        entity_id = target.get("entityId")
        if not isinstance(entity_id, str) or not is_canonical_identity(entity_id):
            errors.append("bad_target_entity_id")

    recorded_at = _parse_iso(record.get("recordedAt"))
    if recorded_at is None:
        errors.append("bad_recorded_at")
    if record.get("validFrom") is not None and _parse_iso(record.get("validFrom")) is None:
        errors.append("bad_valid_from")
    if record.get("validTo") is not None and _parse_iso(record.get("validTo")) is None:
        errors.append("bad_valid_to")

    return errors
