"""Canonical Resource Model（统一资源契约，ADR-007 / NO-02c）。

权威契约：contracts/resource/resource.schema.json + contracts/resource/test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义（锁定双侧已收敛事实）：
- 状态 AVAILABLE|RESERVED|BUSY|DEGRADED|OFFLINE|MAINTENANCE|UNKNOWN；
- dataQuality FRESH|STALE|UNKNOWN；source AUTHORITATIVE|DERIVED；
- 可用性判定确定性 fail-closed：仅 AVAILABLE ∧ FRESH 视为可用；
  其余状态不可用且区分原因。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .risk import DomainContractError

STATUSES: frozenset = frozenset(
    {"AVAILABLE", "RESERVED", "BUSY", "DEGRADED", "OFFLINE", "MAINTENANCE", "UNKNOWN"}
)
DATA_QUALITIES: frozenset = frozenset({"FRESH", "STALE", "UNKNOWN"})
SOURCES: frozenset = frozenset({"AUTHORITATIVE", "DERIVED"})
RESOURCE_TYPES: frozenset = frozenset({"person", "device", "station", "tool", "material", "vehicle"})

# 不可用原因（确定性输出，供解释/审计；与共享向量逐项一致）
_UNAVAILABLE_REASON = {
    "RESERVED": "reserved",
    "BUSY": "busy",
    "DEGRADED": "degraded",
    "OFFLINE": "offline",
    "MAINTENANCE": "maintenance",
    "UNKNOWN": "unknown_status",
}


def is_valid_status(value: str) -> bool:
    return value in STATUSES


def require_status(value: str) -> str:
    if not is_valid_status(value):
        raise DomainContractError("unknown_status", f"资源状态不在注册表: {value!r}")
    return value


def is_valid_data_quality(value: str) -> bool:
    return value in DATA_QUALITIES


def is_valid_resource_type(value: str) -> bool:
    return value in RESOURCE_TYPES


def evaluate_availability(status: str, data_quality: str) -> dict[str, Any]:
    """确定性可用性判定（契约规则）：仅 AVAILABLE ∧ FRESH 可用。

    返回 {"available": bool, "reason": str|null}；非法 status → 抛 DomainContractError
    （fail-closed，绝不把非法值当可用）。
    """
    require_status(status)
    if not is_valid_data_quality(data_quality):
        raise DomainContractError("unknown_data_quality", f"dataQuality 不在注册表: {data_quality!r}")
    if status == "AVAILABLE":
        if data_quality == "FRESH":
            return {"available": True, "reason": None}
        # STALE/UNKNOWN：契约 fail-closed 规则（与 scheduler.ts 既有注释一致）
        return {"available": False, "reason": "stale_data"}
    return {"available": False, "reason": _UNAVAILABLE_REASON.get(status, "unknown_status")}
