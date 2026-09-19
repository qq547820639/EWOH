"""Canonical Dead Letter 契约（ADR-024 / NO-11a，§20 Reliability 失败终态）。

权威契约：contracts/reliability/dead-letter.schema.json +
dead-letter.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js reliability 域门禁强制。

语义（§20 + ADR-024）：
- 永久失败消息的终态台账：envelope 快照必填（§3 失败也要可审计）；
- reason ∈ 封闭注册表；status ∈ {pending, requeued, discarded}；
- attempts ≥ 1 整数（requeue 人审触发 attempts+1，杜绝自动无限重试）；
- discarded 必须带非空 discardedReason（§33 不静默）；
- auditTrail 必须 true。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

REASONS: tuple[str, ...] = (
    "contract_violation", "unknown_event_type", "permanent_failure",
    "ttl_expired", "max_attempts_exceeded",
    # 2026-09-15 仿真对抗审计补注册（与 shared/dead-letter.ts 同步锁步）：
    # cloud:ingest 的坏时钟拒绝与事件写库失败死信此前不合法（unknown_reason），
    # "落死信人审"承诺静默失效。
    "clock_drift_future", "event_write_failed",
)
STATUSES: tuple[str, ...] = ("pending", "requeued", "discarded")

_REQUIRED_FIELDS = (
    "letterId", "sourceId", "reason", "attempts", "status",
    "envelope", "correlationId", "auditTrail",
)


def validate_dead_letter(record: Any) -> list[str]:
    """校验死信记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["letterId"], str) or not record["letterId"]:
        return ["bad_letter_id"]
    if not isinstance(record["sourceId"], str) or not record["sourceId"]:
        return ["bad_source"]
    if record["reason"] not in REASONS:
        return ["unknown_reason"]
    attempts = record["attempts"]
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1:
        return ["bad_attempts"]
    if record["status"] not in STATUSES:
        return ["unknown_status"]
    if not isinstance(record["envelope"], dict) or not record["envelope"]:
        return ["envelope_required"]
    if record["status"] == "discarded":
        reason_text = record.get("discardedReason")
        if not isinstance(reason_text, str) or not reason_text.strip():
            return ["discard_reason_required"]
    correlation = record["correlationId"]
    if correlation is not None and not isinstance(correlation, str):
        return ["bad_correlation"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []
