#!/usr/bin/env python3
"""执行机构路由域（NO-59b）：AGV/PLC 的状态读面与命令下发面。

- ``GET  /api/actuators``                       已注册执行机构清单（设备信息 + 健康 + 状态）
- ``GET  /api/actuators/{deviceId}``            单台状态（未注册 → 404，不返回"空状态"）
- ``POST /api/actuators/{deviceId}/commands``   下发命令（授权 fail-closed）

命令面语义（与 ``adapter.send_command`` 同一判定顺序，路由只做协议映射）：
- 请求体：``{commandKey, authorizationRef?, payload?}``；缺 commandKey/invalid JSON → 400；
- 未注册设备 → 404；已注册但不是执行机构 → 400（显式说明，不静默当作不支持）；
- 授权缺失 → 403（``authorization_required``）；授权号形状非法 → 400（``authorization_ref_invalid``）
  ——"没给授权"与"给错授权"是两件事，页面要能区分；
- 高位命令让设备动起来/解除安全停机；``stop`` 是安全动作，不要求授权（安全停机不被审批链卡住）；
- production 下高危命令还必须携带与 control downlink 同契约的 HMAC 授权范围指纹；
  范围签名绑定 request/device/command/payload，同签名重放显式拒绝，审计预写失败不下发；
- 传输未就绪 → 503；设备故障态 → 409；
- 无论接受还是拒绝，都写一条**审计**（``actuator.command``，含命令/授权号/结果/原因）——
  命令面绝不能"悄悄没发出去"。
"""

import json
import os

from edge_platform.edge.adapters.actuator.protocol import (
    ACTUATOR_HIGH_RISK_COMMANDS,
    is_signed_authorization_fingerprint,
    verify_authorization_fingerprint,
)

from . import Route, dispatch_routes, exact, sub_path
from ._util import now_iso, resolve_actor, runtime_mode


def _actuator_adapters(ctx):
    """列出所有执行机构适配器（type=agv 或声明了 mode=actuator）。"""
    manager = getattr(ctx, "manager", None)
    if manager is None:
        return []
    out = []
    for info in manager.device_info():
        if str(info.get("type")) == "agv" or str(info.get("mode")) == "actuator":
            adapter = manager.find_adapter(info.get("device_id"))
            if adapter is not None:
                out.append(adapter)
    return out


def _state_of(adapter):
    poll = getattr(adapter, "poll_state", None)
    if callable(poll):
        return poll()
    return {"device_id": adapter.device_id, "state": "unknown"}


def api_actuators_list(ctx, h, req_meta):
    adapters = _actuator_adapters(ctx)
    items = []
    for adapter in adapters:
        item = dict(adapter.device_info())
        item["health"] = adapter.health()
        item["state"] = _state_of(adapter)
        item["command_log_size"] = len(getattr(adapter, "command_log", []) or [])
        items.append(item)
    return h.send_json({"adapters": items, "count": len(items), "generated_at": now_iso()})


def api_actuator_detail(ctx, h, req_meta):
    device_id = req_meta.path[len("/api/actuators/") :].split("/")[0]
    manager = getattr(ctx, "manager", None)
    adapter = manager.find_adapter(device_id) if manager is not None else None
    if adapter is None:
        # 未注册 ≠ 空闲：显式 404，绝不返回一个看起来正常的空状态。
        return h.send_json({"error": "unknown actuator", "device_id": device_id}, 404)
    if str(getattr(adapter, "DEVICE_TYPE", "")) != "agv" and not hasattr(adapter, "send_command"):
        return h.send_json({"error": "device is not an actuator", "device_id": device_id}, 400)
    return h.send_json(
        {
            "device": adapter.device_info(),
            "health": adapter.health(),
            "state": _state_of(adapter),
            "recent_commands": (getattr(adapter, "command_log", []) or [])[-10:],
        }
    )


def _audit(ctx, actor, device_id, payload, result, ok):
    try:
        ctx.storage.insert_audit_log(
            action="actuator.command",
            actor_id=actor or "anonymous",
            target_type="device",
            target_id=device_id,
            before=None,
            after={"request": payload, "result": result},
            result="success" if ok else "rejected",
        )
    except Exception as exc:  # 审计写失败不能让命令结果失真：显式记录在响应里
        result.setdefault("audit_error", f"{type(exc).__name__}: {exc}")


def _verify_production_authorization(body, device_id, command_key, payload):
    """Require a platform-signed scope before a production high-risk actuation.

    The adapter's shape check remains as defense in depth, but a syntactically
    valid ``control:*`` reference is not an approval. Production HTTP callers
    must present the same signed fingerprint contract used by the control
    downlink, with the request id, device, command and payload bound together.
    """
    request_id = str(body.get("requestId") or "").strip()
    authorization_ref = str(body.get("authorizationRef") or "").strip()
    fingerprint = body.get("authorizationFingerprint")
    scope = body.get("authorizationScope") if isinstance(body.get("authorizationScope"), dict) else None
    if not request_id or authorization_ref != f"control:{request_id}" or not scope:
        return None, ("authorization_proof_invalid", 403)
    if not is_signed_authorization_fingerprint(fingerprint):
        return None, ("authorization_proof_invalid", 403)
    secret = os.environ.get("EWOH_CONTROL_FINGERPRINT_SECRET", "").strip()
    if not secret:
        return None, ("authorization_secret_unconfigured", 503)
    scope_ok = (
        str(scope.get("requestId") or "") == request_id
        and str(scope.get("deviceId") or "") == device_id
        and str(scope.get("commandKey") or "") == command_key
    )
    if not scope_ok:
        return None, ("authorization_scope_mismatch", 403)
    valid, reason = verify_authorization_fingerprint(
        fingerprint,
        request_id=request_id,
        device_id=device_id,
        command_key=command_key,
        approval_instance_id=scope.get("approvalInstanceId"),
        payload=payload,
        secret=secret,
        scope_present=True,
    )
    if not valid:
        return None, (reason or "authorization_proof_invalid", 403)
    return fingerprint, None


def api_actuator_command(ctx, h, req_meta):
    device_id = req_meta.path[len("/api/actuators/") :].split("/")[0]
    raw = getattr(req_meta, "body", None)
    if isinstance(raw, dict):
        # server 层已解析过 body（不同分发路径传 dict），直接用；不再二次 json.loads
        body = raw
    else:
        try:
            body = json.loads(raw or "{}")
        except (json.JSONDecodeError, TypeError, AttributeError):
            return h.send_json({"error": "bad_request", "message": "请求体非合法 JSON"}, 400)
    if not isinstance(body, dict):
        return h.send_json({"error": "bad_request", "message": "请求体必须为 JSON 对象"}, 400)
    command_key = str(body.get("commandKey") or "").strip()
    authorization_ref = body.get("authorizationRef")
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    if command_key == "":
        return h.send_json({"error": "commandKey is required"}, 400)

    manager = getattr(ctx, "manager", None)
    adapter = manager.find_adapter(device_id) if manager is not None else None
    if adapter is None:
        return h.send_json({"error": "unknown actuator", "device_id": device_id}, 404)
    sender = getattr(adapter, "send_command", None)
    if not callable(sender):
        return h.send_json({"error": "device is not an actuator", "device_id": device_id}, 400)

    # 操作人取 token 身份（客户端自报的 actor 只在无 token 的本地模式兜底，见 _util.resolve_actor）
    actor = resolve_actor(h, body)
    proof_fingerprint = None
    if runtime_mode() == "production" and command_key in ACTUATOR_HIGH_RISK_COMMANDS:
        proof_fingerprint, proof_error = _verify_production_authorization(
            body, device_id, command_key, payload
        )
        if proof_error:
            reason, status = proof_error
            result = {
                "accepted": False,
                "reason": reason,
                "device_id": device_id,
                "command_key": command_key,
                "at": now_iso(),
            }
            _audit(
                ctx,
                actor,
                device_id,
                {"commandKey": command_key, "authorizationRef": authorization_ref, "payload": payload},
                result,
                False,
            )
            return h.send_json(result, status)
        seen = getattr(ctx, "actuator_command_fingerprints", None)
        if seen is None:
            seen = set()
            ctx.actuator_command_fingerprints = seen
        if proof_fingerprint in seen:
            result = {
                "accepted": False,
                "reason": "duplicate_command",
                "device_id": device_id,
                "command_key": command_key,
                "at": now_iso(),
            }
            _audit(
                ctx,
                actor,
                device_id,
                {"commandKey": command_key, "authorizationRef": authorization_ref, "payload": payload},
                result,
                False,
            )
            return h.send_json(result, 409)
        try:
            ctx.storage.insert_audit_log(
                action="actuator.command.intent",
                actor_id=actor or "anonymous",
                target_type="device",
                target_id=device_id,
                before=None,
                after={"request": body, "proof_fingerprint": proof_fingerprint},
                result="pending",
            )
        except Exception as exc:
            return h.send_json(
                {
                    "accepted": False,
                    "reason": "audit_unavailable",
                    "audit_error": f"{type(exc).__name__}: {exc}",
                    "device_id": device_id,
                    "command_key": command_key,
                    "at": now_iso(),
                },
                503,
            )
    result = sender(command_key, authorization_ref, payload)
    if proof_fingerprint and result.get("accepted"):
        ctx.actuator_command_fingerprints.add(proof_fingerprint)
    reason = result.get("reason")
    status = 202 if result.get("accepted") else _status_for_reason(reason)
    result["decided_at"] = now_iso()
    _audit(
        ctx,
        actor,
        device_id,
        {"commandKey": command_key, "authorizationRef": authorization_ref, "payload": payload},
        result,
        bool(result.get("accepted")),
    )
    return h.send_json(result, status)


#: 拒绝原因前缀 → HTTP 状态码（有区分度：没给授权 403 / 给错 400 / 设备故障 409 / 传输未就绪 503）
_REASON_STATUS = (
    ("authorization_required", 403),
    ("authorization_ref_invalid", 400),
    ("unknown_command_key", 400),
    ("target_station_required", 400),
    ("transport_offline", 503),
    ("transport_closed", 503),
    ("transport_error", 503),
    ("device_fault", 409),
    ("not_moving", 409),
    ("not_paused", 409),
    ("no_active_fault", 409),
)


def _status_for_reason(reason):
    """拒绝原因 → HTTP 状态码（表驱动，未登记原因按 400 处理并保留原始 reason）。"""
    value = str(reason or "")
    for prefix, status in _REASON_STATUS:
        if value.startswith(prefix):
            return status
    return 400


DOMAIN_ROUTES = [
    Route("GET", "/api/actuators", exact("/api/actuators"), api_actuators_list),
    Route("GET", "/api/actuators/{deviceId}", sub_path("/api/actuators/"), api_actuator_detail),
    Route("POST", "/api/actuators/{deviceId}/commands", sub_path("/api/actuators/"), api_actuator_command),
]


def handle_actuators(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
