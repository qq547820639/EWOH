"""Canonical Location Model（统一空间契约，ADR-007 / NO-02c）。

权威契约：contracts/location/location.schema.json + contracts/location/test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- 空间类型封闭注册表（v1.1 22 类，2026-08-20 增 corridor）；
- 坐标类型 FACTORY_CARTESIAN|WGS84|UNKNOWN；UNKNOWN=无坐标可用（禁止携带坐标值）；
- FACTORY_CARTESIAN 约定：米制、+X 东 +Y 北 +Z 上、yaw 自北顺时针 [0,360)；
- WGS84 约束 lat∈[-90,90]（x 轴）、lng∈[-180,180]（y 轴）；越界拒绝。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .risk import DomainContractError

SPATIAL_KINDS: frozenset = frozenset(
    {
        "factory",
        "building",
        "floor",
        "area",
        "workshop",
        "production_line",
        "zone",
        "workstation",
        "station",
        "dock",
        "warehouse_location",
        # corridor（通道，2026-08-20 v1.1）：车间间连接走廊；与 TS/JSON 契约同步注册。
        "corridor",
        "route",
        "restricted_zone",
        "device",
        "person",
        "task",
        "camera",
        "sensor",
        "uwb_station",
        "charging_area",
        "staging_area",
    }
)

COORDINATE_TYPES: frozenset = frozenset({"FACTORY_CARTESIAN", "WGS84", "UNKNOWN"})
WGS84_LAT_MIN, WGS84_LAT_MAX = -90.0, 90.0
WGS84_LNG_MIN, WGS84_LNG_MAX = -180.0, 180.0
YAW_MIN, YAW_MAX = 0.0, 360.0


def is_valid_spatial_kind(value: str) -> bool:
    return value in SPATIAL_KINDS


def require_spatial_kind(value: str) -> str:
    if not is_valid_spatial_kind(value):
        raise DomainContractError("unknown_spatial_kind", f"空间类型不在注册表: {value!r}")
    return value


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_location_record(record: Any) -> list[str]:
    """校验坐标记录；返回错误列表（空 = 合法）。fail-closed，不做隐式归一。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    coordinate_type = record.get("coordinateType")
    if coordinate_type not in COORDINATE_TYPES:
        return ["bad_coordinate"]

    has_coord = any(record.get(k) is not None for k in ("x", "y", "z", "yawDeg"))
    if coordinate_type == "UNKNOWN":
        return [] if not has_coord else ["bad_coordinate"]

    errors: list[str] = []
    if coordinate_type == "WGS84":
        x, y = record.get("x"), record.get("y")
        if x is None or y is None:
            return ["bad_coordinate"]
        if not _is_number(x) or not (WGS84_LAT_MIN <= x <= WGS84_LAT_MAX):
            errors.append("bad_coordinate")
        if not _is_number(y) or not (WGS84_LNG_MIN <= y <= WGS84_LNG_MAX):
            errors.append("bad_coordinate")
    else:  # FACTORY_CARTESIAN
        for key in ("x", "y", "z"):
            value = record.get(key)
            if value is not None and not _is_number(value):
                errors.append("bad_coordinate")

    yaw = record.get("yawDeg")
    if yaw is not None:
        if not _is_number(yaw) or not (YAW_MIN <= yaw < YAW_MAX):
            errors.append("bad_coordinate")

    confidence = record.get("confidence")
    if confidence is not None and (not _is_number(confidence) or not (0.0 <= confidence <= 1.0)):
        errors.append("bad_coordinate")

    return errors
