#!/usr/bin/env python3
"""边缘安灯路由（ADR-040 / §6 Phase 6：andon-loop 边缘上行）。

- POST /api/andon/raise    现场开灯（规范身份 fail-closed + 严重度词表
  封闭校验）→ AndonRaised Catalog 信封事件经 STREAM_EVENTS →
  EventUplink 上行（at-least-once + 离线断点续传，ADR-009/NO-04b 语义）。

边界：边缘只生产开灯事实（不落本地安灯台账——云侧 ewoh_event 权威投影
为唯一台账，§3 无第二事实源）；云侧 ingest 将边缘 AndonRaised 投影为
canonical andon evidence 形状（andonId/deviceId/level/slaMinutes/
escalationLevel/timeline）+ 通知闭环（ADR-037）。
"""

import json
import uuid

from edge_platform.contracts import envelope as envelope_contract
from edge_platform.contracts.event_catalog import EVENT_CATALOG_TYPES

from . import Route, dispatch_routes, exact
from ._util import now_iso

_CATALOG_TYPES = frozenset(EVENT_CATALOG_TYPES)

# ADR-027：canonical severity 词表（closed；未知词显式拒绝，绝不静默改写）。
_SEVERITY_LADDER = frozenset(("critical", "high", "medium", "low"))

_DEFAULT_SLA_SECONDS = 900


def _is_device_identity(value):
    return isinstance(value, str) and value.startswith("device:")


def _emit_andon_event(ctx, payload):
    """构造 AndonRaised Catalog 信封 → 契约校验 fail-closed → STREAM_EVENTS 发布。"""
    envelope = {
        "eventId": f"EVT-{uuid.uuid4().hex[:12]}",
        "eventType": "AndonRaised",
        "schemaVersion": "1.0.0",
        "occurredAt": payload["raisedAt"],
        "observedAt": now_iso(),
        "receivedAt": now_iso(),
        "source": "edge:andon",
        "subject": payload["deviceId"],
        "payload": payload,
    }
    errors = envelope_contract.validate_envelope(envelope, _CATALOG_TYPES)
    if errors:
        return False, errors
    bus = getattr(ctx, "bus", None)
    if bus is not None:
        bus.publish("events", {"envelope": envelope})
    return True, []


def api_andon_raise(ctx, h, req_meta):
    """POST /api/andon/raise — 现场开灯（设备规范身份 + 标题必填，fail-closed）。"""
    try:
        body = json.loads(req_meta.body or "{}")
    except (json.JSONDecodeError, AttributeError):
        return h.send_json({"error": "bad_request", "message": "请求体非合法 JSON"}, 400)
    if not isinstance(body, dict):
        return h.send_json({"error": "bad_request", "message": "请求体必须为 JSON 对象"}, 400)

    device_id = (body.get("deviceId") or "").strip()
    title = (body.get("title") or "").strip()
    if not _is_device_identity(device_id):
        return h.send_json(
            {"error": "bad_device_identity", "message": "deviceId 必须为 device: 规范身份（ADR-006）"},
            400,
        )
    if not title:
        return h.send_json({"error": "bad_request", "message": "title 必填（安灯事实不可无标题）"}, 400)

    severity = body.get("severity")
    if severity is None:
        severity = "high"
    severity = str(severity).strip()
    if severity not in _SEVERITY_LADDER:
        return h.send_json(
            {"error": "bad_severity", "message": "severity 必须为 critical/high/medium/low（ADR-027 词表）"},
            400,
        )

    sla_seconds = body.get("slaSeconds", _DEFAULT_SLA_SECONDS)
    if isinstance(sla_seconds, bool) or not isinstance(sla_seconds, (int, float)) or int(sla_seconds) <= 0:
        return h.send_json({"error": "bad_sla_seconds", "message": "slaSeconds 必须为正数"}, 400)
    sla_seconds = int(sla_seconds)

    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        return h.send_json({"error": "bad_reason", "message": "reason 必须为字符串"}, 400)
    assignee = body.get("assignee")
    if assignee is not None and not isinstance(assignee, str):
        return h.send_json({"error": "bad_assignee", "message": "assignee 必须为字符串"}, 400)

    raised_at = body.get("raisedAt") or now_iso()
    payload = {
        "deviceId": device_id,
        "title": title,
        "reason": (reason or "").strip() or None,
        "level": severity,
        "assignee": (assignee or "").strip() or None,
        "slaSeconds": sla_seconds,
        "raisedAt": raised_at,
    }
    ok, errors = _emit_andon_event(ctx, payload)
    if not ok:
        return h.send_json({"error": "envelope_invalid", "message": "; ".join(errors)}, 500)
    return h.send_json(
        {
            "eventType": "AndonRaised",
            "deviceId": device_id,
            "level": severity,
            "slaSeconds": sla_seconds,
        },
        201,
    )


ROUTES = [
    Route("POST", "/api/andon/raise", exact("/api/andon/raise"), api_andon_raise),
]


def handle_andon(ctx, h, req_meta):
    return dispatch_routes(ROUTES, ctx, h, req_meta)


DOMAIN_ROUTES = ROUTES
