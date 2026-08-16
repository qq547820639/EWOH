#!/usr/bin/env python3
"""外骨骼绑定路由（ADR-033 / §7：边缘绑定事实一等 API）。

- POST /api/exo/bind    显式领用（规范身份 fail-closed；同外骨骼活跃绑定唯一）
- POST /api/exo/unbind  显式归还（状态机 active→ended + ended_by 必填）

绑定/解绑落本地账（storage.exo_binding，Edge 采集面）后发射 Catalog
信封事件 ExoSessionStarted/Ended 经 STREAM_EVENTS → EventUplink 上行
（云侧 ewoh_exo_session 台账为权威；离线时事件经断点续传队列保留）。
"""

import json
import uuid

from edge_platform.contracts import envelope as envelope_contract
from edge_platform.contracts.event_catalog import EVENT_CATALOG_TYPES

from . import Route, dispatch_routes, exact
from ._util import now_iso

_CATALOG_TYPES = frozenset(EVENT_CATALOG_TYPES)

_EDGE_EVENT_CODES = {
    "ExoSessionStarted": "EXO_SESSION_STARTED",
    "ExoSessionEnded": "EXO_SESSION_ENDED",
}


def _is_device_identity(value):
    return isinstance(value, str) and value.startswith("device:")


def _is_person_identity(value):
    return isinstance(value, str) and value.startswith("person:")


def _emit_session_event(ctx, event_type, payload):
    """构造 Catalog 信封事件 → 契约校验 fail-closed → STREAM_EVENTS 发布。"""
    envelope = {
        "eventId": f"EVT-{uuid.uuid4().hex[:12]}",
        "eventType": event_type,
        "schemaVersion": "1.0.0",
        "occurredAt": now_iso(),
        "observedAt": now_iso(),
        "receivedAt": now_iso(),
        "source": "edge:exo-binding",
        "payload": payload,
    }
    errors = envelope_contract.validate_envelope(envelope, _CATALOG_TYPES)
    if errors:
        return False, errors
    bus = getattr(ctx, "bus", None)
    if bus is not None:
        bus.publish("events", {"envelope": envelope})
    return True, []


def api_exo_bind(ctx, h, req_meta):
    """POST /api/exo/bind — 显式领用：规范身份 + 活跃唯一（fail-closed）。"""
    try:
        body = json.loads(req_meta.body or "{}")
    except (json.JSONDecodeError, AttributeError):
        return h.send_json({"error": "bad_request", "message": "请求体非合法 JSON"}, 400)
    if not isinstance(body, dict):
        return h.send_json({"error": "bad_request", "message": "请求体必须为 JSON 对象"}, 400)
    exo_id = (body.get("exoId") or "").strip()
    person_id = (body.get("personId") or "").strip()
    if not _is_device_identity(exo_id):
        return h.send_json({"error": "bad_exo_identity", "message": "exoId 必须为 device: 规范身份（ADR-006/032）"}, 400)
    if not _is_person_identity(person_id):
        return h.send_json({"error": "bad_person_identity", "message": "personId 必须为 person: 规范身份（ADR-006/032）"}, 400)
    storage = getattr(ctx, "storage", None)
    if storage is None or not hasattr(storage, "start_binding"):
        return h._new_error("binding_unavailable", "绑定存储未装配", 503)
    if storage.list_active_binding_for_exo(exo_id) is not None:
        return h.send_json(
            {"error": "conflict_exo_binding_active", "message": "该外骨骼已有活跃绑定（先归还再领用，§7）"}, 409
        )
    started_at = body.get("startedAt") or now_iso()
    binding_id = body.get("bindingId") or f"exo-bind:{uuid.uuid4().hex[:12]}"
    session_id = body.get("sessionId") or f"exo-session:{uuid.uuid4().hex[:12]}"
    try:
        record = storage.start_binding(binding_id, exo_id, person_id, started_at)
    except Exception as exc:  # noqa: BLE001 - 唯一性兜底显式
        return h.send_json(
            {"error": "conflict_exo_binding_active", "message": f"绑定落账冲突: {exc}"}, 409
        )
    ok, errors = _emit_session_event(ctx, "ExoSessionStarted", {
        "orgId": "",
        "sessionId": session_id,
        "exoId": exo_id,
        "personId": person_id,
        "startedAt": started_at,
    })
    return h.send_json({
        "binding": record,
        "sessionId": session_id,
        "eventEmitted": ok,
        "eventErrors": errors,
    })


def api_exo_unbind(ctx, h, req_meta):
    """POST /api/exo/unbind — 显式归还：状态机 active→ended + ended_by 必填。"""
    try:
        body = json.loads(req_meta.body or "{}")
    except (json.JSONDecodeError, AttributeError):
        return h.send_json({"error": "bad_request", "message": "请求体非合法 JSON"}, 400)
    if not isinstance(body, dict):
        return h.send_json({"error": "bad_request", "message": "请求体必须为 JSON 对象"}, 400)
    binding_id = (body.get("bindingId") or "").strip()
    exo_id = (body.get("exoId") or "").strip()
    ended_by = (body.get("endedBy") or "").strip()
    if not binding_id and not exo_id:
        return h.send_json({"error": "bad_request", "message": "bindingId 或 exoId 必填"}, 400)
    if not ended_by:
        return h.send_json({"error": "ended_by_required", "message": "endedBy 必填（结束事实完整，§33）"}, 400)
    storage = getattr(ctx, "storage", None)
    if storage is None or not hasattr(storage, "end_binding"):
        return h._new_error("binding_unavailable", "绑定存储未装配", 503)
    target = storage.get_binding(binding_id)
    if target is None and exo_id:
        target = storage.list_active_binding_for_exo(exo_id)
    if target is None:
        return h.send_json({"error": "binding_not_found", "message": "绑定不存在或已结束"}, 404)
    if target["status"] != "active":
        return h.send_json({"error": "illegal_transition", "message": f"绑定状态 {target['status']} 不可归还（终态）"}, 409)
    ended_at = now_iso()
    ok_end = storage.end_binding(target["binding_id"], ended_at, ended_by, body.get("reason") or "")
    if not ok_end:
        return h.send_json({"error": "illegal_transition", "message": "并发结束冲突，请重试"}, 409)
    session_id = body.get("sessionId") or ""
    ok, errors = _emit_session_event(ctx, "ExoSessionEnded", {
        "orgId": "",
        "sessionId": session_id,
        "exoId": target["exo_id"],
        "personId": target["person_id"],
        "status": "ended",
        "endedBy": ended_by,
        "actualEndAt": ended_at,
    })
    return h.send_json({
        "binding": storage.get_binding(target["binding_id"]),
        "eventEmitted": ok,
        "eventErrors": errors,
    })


ROUTES = [
    Route("POST", "/api/exo/bind", exact("/api/exo/bind"), api_exo_bind),
    Route("POST", "/api/exo/unbind", exact("/api/exo/unbind"), api_exo_unbind),
]


def handle_exo(ctx, h, req_meta):
    return dispatch_routes(ROUTES, ctx, h, req_meta)


DOMAIN_ROUTES = ROUTES
