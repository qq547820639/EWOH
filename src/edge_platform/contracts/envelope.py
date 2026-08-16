"""Canonical Event Envelope（统一事件信封契约，ADR-009 / NO-04）。

权威契约：contracts/events/envelope.schema.json + envelope-test-vectors.json。
事件目录（contracts/events/event-catalog.yaml）= 类型语义；本模块 = 信封形状 +
时间/因果/置信度语义（目录类型交叉校验由门禁与调用方注入目录类型集合完成）。

语义：
- 必填 eventId/eventType/schemaVersion/occurredAt/source；
- 时间三态 occurredAt ≤ observedAt ≤ receivedAt（漂移容忍 5min，越界标记 clockDrift，
  不静默改写时间）；
- 迟到：receivedAt − occurredAt > 10min → isLate（标记不丢弃）；
- actor/subject 必须是规范身份（ADR-006）；confidence ∈ [0,1]；
- 幂等：同一 (source, eventId) 重放幂等（消费者按 eventId 去重）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .identity import is_canonical_identity

CLOCK_DRIFT_TOLERANCE_MS = 300_000  # 5min
LATE_THRESHOLD_MS = 600_000  # 10min
REQUIRED_FIELDS = ("eventId", "eventType", "schemaVersion", "occurredAt", "source")


def parse_ts(value: Any):
    """ISO 8601 → 毫秒（容忍 Z；缺失 Z 视为 UTC）；非法返回 None。"""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def validate_envelope(envelope: dict, known_event_types: frozenset) -> list[str]:
    """校验信封；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(envelope, dict):
        return ["record_must_be_object"]
    if not isinstance(envelope.get("eventType"), str) or not envelope.get("eventType"):
        return ["missing_event_type"]
    for field in REQUIRED_FIELDS:
        if field not in envelope:
            return [f"missing_field:{field}"]
    if not isinstance(envelope["eventId"], str) or not envelope["eventId"]:
        return ["bad_event_id"]
    if envelope["eventType"] not in known_event_types:
        return ["unknown_event_type"]
    if not isinstance(envelope["schemaVersion"], str) or not envelope["schemaVersion"]:
        return ["bad_schema_version"]
    occurred = parse_ts(envelope["occurredAt"])
    if occurred is None:
        return ["bad_occurred_at"]
    if not isinstance(envelope["source"], str) or not envelope["source"]:
        return ["bad_source"]
    observed = parse_ts(envelope.get("observedAt")) if envelope.get("observedAt") is not None else None
    received = parse_ts(envelope.get("receivedAt")) if envelope.get("receivedAt") is not None else None
    if envelope.get("observedAt") is not None and observed is None:
        return ["bad_observed_at"]
    if envelope.get("receivedAt") is not None and received is None:
        return ["bad_received_at"]
    for ref_key in ("actor", "subject"):
        ref = envelope.get(ref_key)
        if ref is not None:
            if not isinstance(ref, str) or not is_canonical_identity(ref):
                return [f"bad_{ref_key}"]
    confidence = envelope.get("confidence")
    if confidence is not None:
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not (0.0 <= confidence <= 1.0):
            return ["bad_confidence"]
    return []


def envelope_semantics(envelope: dict) -> dict[str, bool]:
    """时间语义画像：clockDrift（越容忍界）/ isLate（超迟到阈值）。

    先决：envelope 已通过 validate_envelope（时间字段可解析）。
    """
    occurred = parse_ts(envelope["occurredAt"])
    observed = parse_ts(envelope.get("observedAt")) if envelope.get("observedAt") is not None else None
    received = parse_ts(envelope.get("receivedAt")) if envelope.get("receivedAt") is not None else None
    clock_drift = False
    if observed is not None and observed + CLOCK_DRIFT_TOLERANCE_MS < occurred:
        clock_drift = True
    if received is not None and received + CLOCK_DRIFT_TOLERANCE_MS < occurred:
        clock_drift = True
    if observed is not None and received is not None and received + CLOCK_DRIFT_TOLERANCE_MS < observed:
        clock_drift = True
    is_late = received is not None and received - occurred > LATE_THRESHOLD_MS
    return {"clockDrift": clock_drift, "isLate": is_late}


def dedup_key(envelope: dict) -> tuple[str, str]:
    """幂等去重键 (source, eventId)。"""
    return (envelope["source"], envelope["eventId"])
