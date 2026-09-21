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
from ._util import now_iso, runtime_mode

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
        return h.send_json(
            {"error": "bad_exo_identity", "message": "exoId 必须为 device: 规范身份（ADR-006/032）"}, 400
        )
    if not _is_person_identity(person_id):
        return h.send_json(
            {"error": "bad_person_identity", "message": "personId 必须为 person: 规范身份（ADR-006/032）"}, 400
        )
    # production 下 manage_devices 只授权“可以管理绑定”，不授权把外骨骼指派给
    # 任意 person。非 admin 必须能由服务端会话解析出同一 person 身份；admin 可代领用。
    if runtime_mode() == "production":
        session = _session(h)
        if session is None:
            return h.send_json(
                {"error": "unauthorized", "message": "production 领用绑定必须携带有效 Bearer token"}, 401
            )
        if session.role != "admin":
            actor_person = _session_actor_person(session)
            if actor_person is None or actor_person != person_id:
                return h.send_json(
                    {"error": "binding_ownership_required", "message": "非 admin 只能领用本人的外骨骼绑定"}, 403
                )
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


def _session(h):
    """取当前请求的服务端会话（R2-ECO-001：授权判定必须基于 token 身份）。

    无会话/未认证/认证服务不可用一律返回 None（fail-closed）。
    """
    from edge_platform.routes._util import session_manager

    sm = session_manager()
    if sm is None:
        return None
    auth = (h.headers.get("Authorization", "") or "").strip()
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):].strip()
    if not token:
        return None
    try:
        return sm.verify(token)
    except Exception:
        return None


def _canonical_session_identity(session):
    """Return the trusted canonical actor identity stored by the identity provider."""
    if session is None:
        return None
    person_id = getattr(session, "person_id", None)
    if _is_person_identity(person_id):
        return person_id
    user_id = getattr(session, "user_id", None)
    return user_id if _is_person_identity(user_id) else None


def _session_actor_person(session):
    """由服务端会话解析操作者的规范 person 身份（R2-ECO-001）。

    当前会话体不携带显式 person 映射；支持两种服务端可信来源：
    - Session 扩展属性 ``person_id``（IdP/预映射注入）；
    - ``user_id`` 本身即 person: 规范身份（外部 IdP 直接以 person 签发）。
    无法解析时返回 None（非 admin 会话不得据此通过归属校验）。
    """
    if session is None:
        return None
    person_id = getattr(session, "person_id", None)
    if _is_person_identity(person_id):
        return person_id
    if _is_person_identity(getattr(session, "user_id", None)):
        return session.user_id
    return None


def api_exo_unbind(ctx, h, req_meta):
    """POST /api/exo/unbind — 显式归还：状态机 active→ended + ended_by 必填。

    EDGE-011 + R2-ECO-001（2026-08-17 审计整改）：production 下绑定归属
    校验只信任服务端 token 会话身份——admin 角色可代归还；非 admin 会话
    必须能从会话侧解析出与绑定主体一致的 person 身份，否则 403。
    请求体 endedBy 仅作记录字段（写入 ended_by / 事件负载），不参与授权。
    development/simulation 保持演示宽松。
    """
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
        return h.send_json(
            {"error": "illegal_transition", "message": f"绑定状态 {target['status']} 不可归还（终态）"}, 409
        )
    # EDGE-011 + R2-ECO-001：production 下校验绑定归属——只信任 token 会话身份。
    # 客户端自报 endedBy 不得参与授权（可先经 /api/devices 读到 person_id 后伪造）。
    trusted_ended_by = ended_by
    if runtime_mode() == "production":
        session = _session(h)
        if session is None:
            return h.send_json(
                {"error": "unauthorized", "message": "production 归还绑定必须携带有效 Bearer token"},
                401,
            )
        actor_person = _session_actor_person(session)
        if session.role != "admin":
            if actor_person is None or actor_person != target.get("person_id"):
                return h.send_json(
                    {
                        "error": "binding_ownership_required",
                        "message": "仅绑定本人或 admin 可结束该活跃绑定（EDGE-011/R2-ECO-001）",
                    },
                    403,
                )
            trusted_ended_by = actor_person
        else:
            # admin 代操作也必须留下服务端身份，客户端 endedBy 只能作为展示字段。
            trusted_ended_by = _canonical_session_identity(session) or actor_person or session.user_id
    ended_at = now_iso()
    ok_end = storage.end_binding(target["binding_id"], ended_at, trusted_ended_by, body.get("reason") or "")
    if not ok_end:
        return h.send_json({"error": "illegal_transition", "message": "并发结束冲突，请重试"}, 409)
    session_id = body.get("sessionId") or ""
    ok, errors = _emit_session_event(ctx, "ExoSessionEnded", {
        "orgId": "",
        "sessionId": session_id,
        "exoId": target["exo_id"],
        "personId": target["person_id"],
        "status": "ended",
        "endedBy": trusted_ended_by,
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
