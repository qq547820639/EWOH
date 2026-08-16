"""Canonical Exo Session 契约（ADR-032 / §7：外骨骼↔人员绑定 Session）。

权威契约：contracts/exo/exo-session.schema.json + exo-session.test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js exo 域门禁强制。

语义（§7 + ADR-032）：
- 绑定必须是显式、临时且可审计的 Session（不得永久假定设备属于某人）；
- status ∈ {active, ended, aborted}（active→ended/aborted 终态，不可复开）；
- exoId/personId 规范身份（device:/person: 前缀，ADR-006）；
- ended/aborted 必须 actualEndAt（结束事实完整）；actualEndAt ≥ startedAt；
- auditTrail 必须 true。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .identity import is_canonical_identity

STATUSES: tuple[str, ...] = ("active", "ended", "aborted")

_REQUIRED_FIELDS = ("sessionId", "exoId", "personId", "status", "startedAt", "auditTrail")


def _is_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        return True
    except ValueError:
        return False


def _iso_ts(value: Any) -> float:
    return datetime.fromisoformat(
        value[:-1] + "+00:00" if str(value).endswith("Z") else str(value)
    ).timestamp()


def validate_exo_session(record: Any) -> list[str]:
    """校验外骨骼会话记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    session_id = record["sessionId"]
    if not isinstance(session_id, str) or not session_id or not session_id.startswith("exo-session:"):
        return ["bad_session_id"]
    exo_id = record["exoId"]
    if not isinstance(exo_id, str) or not is_canonical_identity(exo_id) or not exo_id.startswith("device:"):
        return ["bad_exo_identity"]
    person_id = record["personId"]
    if not isinstance(person_id, str) or not is_canonical_identity(person_id) or not person_id.startswith("person:"):
        return ["bad_person_identity"]
    if record["status"] not in STATUSES:
        return ["unknown_status"]
    started = record["startedAt"]
    if not _is_iso(started):
        return ["bad_start_time"]
    actual_end = record.get("actualEndAt")
    if record["status"] in ("ended", "aborted"):
        if not _is_iso(actual_end):
            return ["actual_end_required"]
        if _iso_ts(actual_end) < _iso_ts(started):
            return ["bad_time_order"]
        if not isinstance(record.get("endedBy"), str) or not record["endedBy"].strip():
            return ["ended_by_required"]
    else:
        if actual_end is not None:
            return ["actual_end_not_allowed"]
    expected_end = record.get("expectedEndAt")
    if expected_end is not None and not _is_iso(expected_end):
        return ["bad_expected_end"]
    operator = record.get("operatorId")
    if operator is not None and (not isinstance(operator, str) or not operator):
        return ["bad_operator"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []


def exo_session_transition_allowed(from_status: str, to_status: str) -> bool:
    """ADR-032 状态机：active→{ended, aborted}；终态不可复开。"""
    return from_status == "active" and to_status in ("ended", "aborted")
