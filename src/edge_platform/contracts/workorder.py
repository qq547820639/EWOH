"""Canonical Work Order Model（统一工单契约，ADR-012 / NO-05e-a）。

权威契约：contracts/workorder/work-order.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- workOrderType 封闭注册表 {maintenance, quality_rework, inspection}；
- origin = {kind ∈ {maintenance_condition, quality_finding}, id} 必填（可追溯）；
- subjectEntityId 必须是规范身份（ADR-006）；
- severity 走 Canonical Risk 阶梯（复用 risk.normalize_severity）；
- 生命周期 created→scheduled→in_progress→completed→closed
  （created/scheduled 可 cancelled；in_progress 起不可取消）；
- completed/closed 必须带 completedAt；cancelled 必须带非空 cancelledReason。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity
from .risk import DomainContractError, normalize_severity

WORK_ORDER_TYPES: frozenset = frozenset({"maintenance", "quality_rework", "inspection"})
ORIGIN_KINDS: frozenset = frozenset({"maintenance_condition", "quality_finding"})
LIFECYCLE: tuple[str, ...] = (
    "created",
    "scheduled",
    "in_progress",
    "completed",
    "closed",
    "cancelled",
)

_TRANSITIONS: frozenset = frozenset(
    {
        ("created", "scheduled"),
        ("scheduled", "in_progress"),
        ("in_progress", "completed"),
        ("completed", "closed"),
        ("created", "cancelled"),
        ("scheduled", "cancelled"),
    }
)
_COMPLETED_STATUSES: frozenset = frozenset({"completed", "closed"})


def is_valid_work_order_type(value: str) -> bool:
    return value in WORK_ORDER_TYPES


def is_valid_status(value: str) -> bool:
    return value in LIFECYCLE


def transition_allowed(from_status: str, to_status: str) -> bool:
    """生命周期转移合法性（in_progress 起不可取消；closed/cancelled 终态）。"""
    if not is_valid_status(from_status) or not is_valid_status(to_status):
        return False
    return (from_status, to_status) in _TRANSITIONS


def _parseable_iso(value: Any) -> bool:
    from .envelope import parse_ts

    return isinstance(value, str) and parse_ts(value) is not None


def validate_work_order(record: Any) -> list[str]:
    """校验 WorkOrder 记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in ("workOrderId", "workOrderType", "origin", "subjectEntityId", "severity", "status"):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["workOrderId"], str) or not record["workOrderId"]:
        return ["bad_work_order_id"]
    if record["workOrderType"] not in WORK_ORDER_TYPES:
        return ["unknown_work_order_type"]
    origin = record["origin"]
    if not isinstance(origin, dict) or "kind" not in origin or "id" not in origin:
        return ["missing_origin"]
    if origin["kind"] not in ORIGIN_KINDS:
        return ["unknown_origin_kind"]
    if not isinstance(origin["id"], str) or not origin["id"]:
        return ["bad_origin_id"]
    if not isinstance(record["subjectEntityId"], str) or not is_canonical_identity(record["subjectEntityId"]):
        return ["bad_subject"]
    if not isinstance(record["severity"], str):
        return ["unknown_severity"]
    try:
        normalize_severity(record["severity"])
    except DomainContractError:
        return ["unknown_severity"]
    status = record["status"]
    if status not in LIFECYCLE:
        return ["unknown_status"]
    scheduled_for = record.get("scheduledFor")
    if scheduled_for is not None and not _parseable_iso(scheduled_for):
        return ["bad_scheduled_for"]
    completed_at = record.get("completedAt")
    if status in _COMPLETED_STATUSES and completed_at is None:
        return ["completed_at_required"]
    if completed_at is not None and not _parseable_iso(completed_at):
        return ["bad_completed_at"]
    if status == "cancelled":
        reason = record.get("cancelledReason")
        if not isinstance(reason, str) or not reason:
            return ["cancelled_reason_required"]
    return []
