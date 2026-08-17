"""Canonical Maintenance Condition Model（统一维护状态契约，ADR-010 / NO-05a）。

权威契约：contracts/maintenance/maintenance.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- conditionType 封闭注册表；subjectEntityId 必须是规范身份（ADR-006）；
- severity 走 Canonical Risk 阶梯（复用 risk.normalize_severity）；
- 生命周期 detected→acknowledged→work_order_created→resolved→closed
  （resolved 前必须 work_order_created；closed 终态）；
- 逾期判定 overdue：dueAt < now 且 status ∉ {resolved, closed}（机器可执行）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity
from .risk import DomainContractError, normalize_severity

CONDITION_TYPES: frozenset = frozenset(
    {"wear", "calibration_due", "fault_recurring", "overdue_inspection", "battery_degradation", "anomaly"}
)
LIFECYCLE: tuple[str, ...] = ("detected", "acknowledged", "work_order_created", "resolved", "closed")

_TRANSITIONS: frozenset = frozenset(
    {
        ("detected", "acknowledged"),
        ("acknowledged", "work_order_created"),
        ("work_order_created", "resolved"),
        ("resolved", "closed"),
    }
)
_RESOLVED_STATUSES: frozenset = frozenset({"resolved", "closed"})


def is_valid_condition_type(value: str) -> bool:
    return value in CONDITION_TYPES


def is_valid_status(value: str) -> bool:
    return value in LIFECYCLE


def transition_allowed(from_status: str, to_status: str) -> bool:
    """生命周期转移合法性（resolved 前必须 work_order_created 由路径强制；closed 终态）。"""
    if not is_valid_status(from_status) or not is_valid_status(to_status):
        return False
    return (from_status, to_status) in _TRANSITIONS


def validate_condition(record: Any) -> list[str]:
    """校验 MaintenanceCondition 记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in ("conditionId", "subjectEntityId", "conditionType", "severity", "status"):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["conditionId"], str) or not record["conditionId"]:
        return ["bad_condition_id"]
    if not isinstance(record["subjectEntityId"], str) or not is_canonical_identity(record["subjectEntityId"]):
        return ["bad_subject"]
    if record["conditionType"] not in CONDITION_TYPES:
        return ["unknown_condition_type"]
    if not isinstance(record["severity"], str):
        return ["unknown_severity"]
    try:
        normalize_severity(record["severity"])
    except DomainContractError:
        return ["unknown_severity"]
    if record["status"] not in LIFECYCLE:
        return ["unknown_status"]
    # EDGE-201（2026-08-17 审计整改说明）：Python 侧显式拒绝 disposition 字段
    # （MaintenanceCondition 契约无此字段，fail-closed）。TS maintenance.ts 的
    # validateMaintenanceCondition 缺同款检查属跨端漂移——按整改分工，TS 侧由
    # 共享契约层任务（W6）补 disposition 拒绝规则与 Python 对齐；Python 侧
    # 保持现状（更严语义为 canonical）。
    if "disposition" in record or record.get("disposition") is not None:
        return ["unexpected_field"]
    return []


def is_overdue(due_at: str | None, status: str, now: str) -> bool:
    """逾期判定：dueAt < now 且 status ∉ {resolved, closed}。

    due_at/now 为 ISO 8601；解析失败 fail-closed → 不判逾期（不伪造）。
    """
    from .envelope import parse_ts

    if due_at is None or status in _RESOLVED_STATUSES:
        return False
    due = parse_ts(due_at)
    now_ms = parse_ts(now)
    if due is None or now_ms is None:
        return False
    return due < now_ms
