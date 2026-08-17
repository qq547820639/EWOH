#!/usr/bin/env python3
"""世界态/设备/事件/演示域路由（Task 9 / P2）。

GET /api/devices、/api/devices/{id}、/api/devices/{id}/health、/api/people、
/api/events、/api/event、/api/events/{id}；POST /api/event/status、/api/reset、
/api/events/{id}/status、/api/events/{id}/comment。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

from datetime import timedelta

from edge_platform import services

from . import Route, affix, dispatch_routes, exact, sub_path
from ._util import (
    SOURCE_LABELS,
    _device_view,
    _filter_source,
    evidence_window_sec,
    now_iso,
    offline_after_sec,
    parse_ts,
    resolve_actor,
)

# EDGE-021：/api/events 用户 limit 的路由层硬上限（服务层另有同值兜底）。
MAX_EVENTS_LIMIT = 1000


def api_devices(ctx, h, req_meta):
    items = [
        _device_view(ctx, d) for d in _filter_source(ctx.storage.list_devices(), h.arg("source"))
    ]
    return h.send_json({"items": items, "now": now_iso(), "offline_after_sec": offline_after_sec()})


def api_people(ctx, h, req_meta):
    return h.send_json({"items": ctx.storage.list_people(), "now": now_iso()})


def api_events_list(ctx, h, req_meta):
    try:
        limit = int(h.arg("limit", "100") or 100)
    except ValueError:
        limit = 100
    limit = max(1, min(limit, MAX_EVENTS_LIMIT))  # EDGE-021：钉死上限，拒绝 1e9 类输入
    items = [services.norm_event(e) for e in ctx.storage.list_events(limit)]
    for e in items:
        e["source_label"] = SOURCE_LABELS.get(e.get("source_type"), e.get("source_type"))
    return h.send_json({"items": _filter_source(items, h.arg("source")), "now": now_iso()})


def api_event_detail(ctx, h, req_meta):
    """事件详情 + 前后各 30 秒证据窗口（可追溯到原始数据）。"""
    eid = h.arg("id")
    evt = services.norm_event(ctx.storage.get_event(eid))
    if not evt:
        return h.send_json({"error": "事件不存在"}, 404)
    t0 = parse_ts(evt.get("start_time"))
    t1 = parse_ts(evt.get("end_time")) or t0
    records, dev_id = [], evt.get("device_id")
    if t0 and dev_id:
        rows = ctx.storage.query_telemetry(
            dev_id,
            services.iso(t0 - timedelta(seconds=evidence_window_sec())),
            services.iso(t1 + timedelta(seconds=evidence_window_sec())),
            500,
        )
        records = [services.norm_telemetry(r) for r in rows]
    evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
    return h.send_json(
        {
            "event": evt,
            "evidence_window_sec": evidence_window_sec(),
            "evidence_records": records,
            "now": now_iso(),
        }
    )


def api_event_status(ctx, h, payload):
    eid, status = payload.get("event_id"), payload.get("status")
    if status not in ("open", "confirmed", "closed", "dismissed"):
        return h.send_json({"error": "非法状态"}, 400)
    handling = payload.get("handling") or {}
    handling.setdefault("handled_by", payload.get("handled_by", ""))
    handling.setdefault("handled_at", now_iso())
    # Task 33：业务级指标——事件开/闭计数与关闭时长
    if ctx.metrics is not None:
        before = services.norm_event(ctx.storage.get_event(eid)) or {}
        if status == "open" and before.get("status") != "open":
            ctx.metrics.record_event_open()
        elif status in ("closed", "dismissed") and before.get("status") not in ("closed", "dismissed"):
            t0 = parse_ts(before.get("start_time"))
            t1 = parse_ts(before.get("end_time")) or parse_ts(handling.get("handled_at"))
            if t0 and t1:
                try:
                    hours = max(0.0, (t1 - t0).total_seconds() / 3600.0)
                    ctx.metrics.record_event_close(hours)
                except Exception as e:  # L3：埋点失败不阻断事件关闭，但记录
                    print(f"[EWOH] metrics.record_event_close failed: {e!r}")
    ctx.storage.update_event_status(eid, status, handling)
    return h.send_json({"ok": True, "event": services.norm_event(ctx.storage.get_event(eid))})


def route_event_status_legacy(ctx, h, req_meta):
    return api_event_status(ctx, h, req_meta.body)


def api_reset(ctx, h, req_meta):
    """一键重置（Task 19）：清空演示派工与模拟态数据；真实数据必须保留。"""
    with ctx.lock:
        ctx.assignments.clear()
    note = "已清空人工确认记录。"
    if hasattr(ctx.storage, "reset_demo"):
        ctx.storage.reset_demo()
        note += "模拟/受控演示数据已重置；真实设备数据不受影响。"
    else:
        note += "持久层数据保持不动（真实数据不做清除）。"
    return h.send_json({"ok": True, "note": note, "now": now_iso()})


def api_device_detail(ctx, h, device_id):
    """GET /api/devices/{device_id} — 单设备详情。"""
    d = next((x for x in ctx.storage.list_devices() if x.get("device_id") == device_id), None)
    if not d:
        return h._new_error("not_found", "设备不存在", 404)
    return h.send_json({"device": _device_view(ctx, d), "now": now_iso()})


def api_device_health(ctx, h, device_id):
    """GET /api/devices/{device_id}/health — 在线/电量/故障/丢包/最后通信。"""
    d = next((x for x in ctx.storage.list_devices() if x.get("device_id") == device_id), None)
    if not d:
        return h._new_error("not_found", "设备不存在", 404)
    rec = services.norm_telemetry(ctx.storage.latest_telemetry(device_id)) or {}
    tele = rec.get("telemetry") or {}
    quality = rec.get("quality") or {}
    health = {
        "device_id": device_id,
        "online": ctx.device_online(d),
        "last_seen": d.get("last_seen"),
        "battery_pct": tele.get("battery_pct", tele.get("battery_percent", tele.get("battery_level"))),
        "fault": bool(tele.get("fault")) or quality.get("status", "good") not in ("good", None, "unknown"),
        "packet_loss_pct": quality.get("packet_loss_pct", 0.0),
        "quality_status": quality.get("status", "unknown"),
        "now": now_iso(),
    }
    return h.send_json(health)


def route_devices_detail(ctx, h, req_meta):
    p = req_meta.path
    parts = p[len("/api/devices/") :].split("/")
    if len(parts) == 1 and parts[0]:
        return api_device_detail(ctx, h, parts[0])
    if len(parts) == 2 and parts[1] == "health":
        return api_device_health(ctx, h, parts[0])
    if len(parts) == 2 and parts[1] == "quality":
        return api_device_quality(ctx, h, parts[0])
    return h._new_error("not_found", "路径不存在", 404)


def api_device_quality(ctx, h, device_id):
    """GET /api/devices/{device_id}/quality — 设备数据质量统计（NO-05）。

    adapter 计数器（bad_crc/malformed/packet_loss/backfill/duplicates/dropped）+
    存储遥测质量分布（good/degraded/invalid/...）；设备不存在 404。
    """
    d = next((x for x in ctx.storage.list_devices() if x.get("device_id") == device_id), None)
    if not d:
        return h._new_error("not_found", "设备不存在", 404)
    adapter_stats = None
    if ctx.manager:
        try:
            for entry in ctx.manager.health() or []:
                if entry.get("device_id") == device_id:
                    adapter_stats = {
                        "status": entry.get("status"),
                        "packet_loss_pct": entry.get("packet_loss_pct"),
                        "bad_crc_frames": entry.get("bad_crc_frames"),
                        "malformed_frames": entry.get("malformed_frames"),
                        "backfill_frames": entry.get("backfill_frames"),
                        "backfill_duplicates": entry.get("backfill_duplicates"),
                        "dropped_frames": entry.get("dropped_frames"),
                        "sink_errors": entry.get("sink_errors"),
                    }
                    break
        except Exception:
            adapter_stats = None
    telemetry_quality = (
        ctx.storage.quality_stats(device_id) if hasattr(ctx.storage, "quality_stats") else {}
    )
    return h.send_json(
        {
            "device_id": device_id,
            "adapter": adapter_stats,
            "telemetry_quality": telemetry_quality,
            "now": now_iso(),
        }
    )


def api_event_detail_v2(ctx, h, event_id):
    """GET /api/events/{event_id} — 单事件详情（含证据/handling）。"""
    evt = services.norm_event(ctx.storage.get_event(event_id))
    if not evt:
        return h._new_error("not_found", "事件不存在", 404)
    t0 = parse_ts(evt.get("start_time"))
    t1 = parse_ts(evt.get("end_time")) or t0
    records, dev_id = [], evt.get("device_id")
    if t0 and dev_id:
        rows = ctx.storage.query_telemetry(
            dev_id,
            services.iso(t0 - timedelta(seconds=evidence_window_sec())),
            services.iso(t1 + timedelta(seconds=evidence_window_sec())),
            500,
        )
        records = [services.norm_telemetry(r) for r in rows]
    evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
    handlings = (
        ctx.storage.list_event_handlings(event_id) if hasattr(ctx.storage, "list_event_handlings") else []
    )
    return h.send_json(
        {
            "event": evt,
            "evidence_window_sec": evidence_window_sec(),
            "evidence_records": records,
            "handlings": handlings,
            "now": now_iso(),
        }
    )


def route_events_detail(ctx, h, req_meta):
    p = req_meta.path
    parts = p[len("/api/events/") :].split("/")
    if len(parts) == 1 and parts[0]:
        return api_event_detail_v2(ctx, h, parts[0])
    return h._new_error("not_found", "路径不存在", 404)


def api_event_status_v2(ctx, h, event_id, payload):
    """POST /api/events/{event_id}/status — 更新事件处置状态。"""
    status = payload.get("status")
    if status not in ("open", "confirmed", "closed", "dismissed"):
        return h._new_error("invalid_status", "非法状态", 400)
    evt = ctx.storage.get_event(event_id)
    if not evt:
        return h._new_error("not_found", "事件不存在", 404)
    handler_id = resolve_actor(h, payload, "handler_id", "handled_by")
    action = payload.get("action") or status
    comment = payload.get("comment")
    handling = {"handled_by": handler_id, "handled_at": now_iso(), "action": action, "comment": comment}
    ctx.storage.update_event_status(event_id, status, handling)
    if hasattr(ctx.storage, "insert_event_handling"):
        ctx.storage.insert_event_handling(
            event_id, handler_id, action, comment=comment, audit_ref=getattr(h, "_request_id", None)
        )
    h._audit_target_type = "risk_event"
    h._audit_target_id = event_id
    return h.send_json({"ok": True, "event": services.norm_event(ctx.storage.get_event(event_id))})


def route_event_status_v2(ctx, h, req_meta):
    p = req_meta.path
    return api_event_status_v2(ctx, h, p[len("/api/events/") : -len("/status")], req_meta.body)


def api_event_comment(ctx, h, event_id, payload):
    """POST /api/events/{event_id}/comment — 添加事件评论。"""
    comment = (payload.get("comment") or "").strip()
    author_id = (resolve_actor(h, payload, "author_id") or "").strip()
    if not comment:
        return h._new_error("invalid_params", "comment 不能为空", 400)
    if not ctx.storage.get_event(event_id):
        return h._new_error("not_found", "事件不存在", 404)
    rec = None
    if hasattr(ctx.storage, "insert_event_handling"):
        rec = ctx.storage.insert_event_handling(
            event_id, author_id, "comment", comment=comment, audit_ref=getattr(h, "_request_id", None)
        )
    h._audit_target_type = "risk_event"
    h._audit_target_id = event_id
    return h.send_json({"ok": True, "handling": rec, "now": now_iso()})


def route_event_comment(ctx, h, req_meta):
    p = req_meta.path
    return api_event_comment(ctx, h, p[len("/api/events/") : -len("/comment")], req_meta.body)


DOMAIN_ROUTES = [
    Route("GET", "/api/devices", exact("/api/devices"), api_devices),
    Route("GET", "/api/people", exact("/api/people"), api_people),
    Route("GET", "/api/events", exact("/api/events"), api_events_list),
    Route("GET", "/api/event", exact("/api/event"), api_event_detail),
    Route("GET", "/api/devices/{id}*", sub_path("/api/devices/"), route_devices_detail),
    Route("GET", "/api/events/{id}*", sub_path("/api/events/"), route_events_detail),
    Route("POST", "/api/event/status", exact("/api/event/status"), route_event_status_legacy),
    Route("POST", "/api/reset", exact("/api/reset"), api_reset),
    Route("POST", "/api/events/{id}/status", affix("/api/events/", "/status"), route_event_status_v2),
    Route("POST", "/api/events/{id}/comment", affix("/api/events/", "/comment"), route_event_comment),
]


def handle_world(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
