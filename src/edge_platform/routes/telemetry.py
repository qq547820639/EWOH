#!/usr/bin/env python3
"""遥测域路由（Task 9 / P2）。

GET /api/telemetry、GET /api/telemetry/series、GET /api/telemetry/export、
POST /api/telemetry/export。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

import json
from datetime import datetime

from edge_platform import services

from . import Route, dispatch_routes, exact
from ._util import SOURCE_LABELS, _filter_source, _latest_state, now_iso, parse_ts
from .auth import enforce_export_role


def api_latest(ctx, h, req_meta):
    device_id = h.arg("device_id")
    if not device_id:
        devices = _filter_source(ctx.storage.list_devices(), h.arg("source"))
        device_id = devices[0]["device_id"] if devices else ""
    rec = _latest_state(ctx, device_id)
    if not rec:
        return h.send_json({"error": "no data", "device_id": device_id, "mode": "realtime"}, 404)
    return h.send_json(rec)


def api_series(ctx, h, req_meta):
    """回放态：按设备+时间段返回原始时间序列（正序）。"""
    device_id, start, end = h.arg("device_id"), h.arg("start"), h.arg("end")
    from ._util import bounded_limit

    limit = bounded_limit(h, "limit", 2000, 5000)  # R2-ECO-003：非数字回落默认+硬上限
    if not (device_id and parse_ts(start) and parse_ts(end)):
        return h.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
    rows = ctx.storage.query_telemetry(
        device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)), limit
    )
    items = [services.norm_telemetry(r) for r in rows]
    inf = [
        services.norm_inference(r)
        for r in ctx.storage.query_inference(
            device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)), limit
        )
    ]
    for r in items:
        r["source_label"] = SOURCE_LABELS.get(r.get("source_type"), r.get("source_type"))
    return h.send_json(
        {
            "device_id": device_id,
            "mode": "replay",
            "items": items,
            "inference": inf,
            "start": start,
            "end": end,
            "now": now_iso(),
        }
    )


def api_export(ctx, h, req_meta):
    """原始数据片段导出（Task 5）：JSON 附件下载，携带来源标识。"""
    if enforce_export_role(ctx, h):
        return
    device_id, start, end = h.arg("device_id"), h.arg("start"), h.arg("end")
    if not (device_id and parse_ts(start) and parse_ts(end)):
        return h.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
    slice_ = ctx.storage.export_slice(device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)))
    if isinstance(slice_, list):
        slice_ = {"records": slice_}
    out = {
        "export_type": "raw_slice",
        "device_id": device_id,
        "start": start,
        "end": end,
        "exported_at": now_iso(),
        "slice": slice_,
    }
    fname = f"ewoh_slice_{device_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return h.send_json(out, download=fname)


def api_export_post(ctx, h, payload):
    """POST /api/telemetry/export — body 导出遥测（需审计）。支持 json/csv。"""
    if enforce_export_role(ctx, h):
        return
    device_id = payload.get("device_id") or ""
    start = payload.get("start") or ""
    end = payload.get("end") or ""
    fmt = (payload.get("format") or "json").lower()
    if not (device_id and parse_ts(start) and parse_ts(end)):
        return h._new_error("invalid_params", "需要 device_id/start/end（ISO 时间）", 400)
    if fmt not in ("json", "csv"):
        return h._new_error("invalid_format", "format 仅支持 json/csv", 400)
    slice_ = ctx.storage.export_slice(device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)))
    if isinstance(slice_, list):
        slice_ = {"records": slice_}
    records = slice_.get("records", [])
    h._audit_target_type = "telemetry"
    h._audit_target_id = device_id
    if fmt == "csv":
        cols = ["record_id", "device_id", "timestamp", "sequence", "source_type", "telemetry", "quality"]
        flat = []
        for r in records:
            row = dict(r)
            row["telemetry"] = json.dumps(r.get("telemetry", {}), ensure_ascii=False)
            row["quality"] = json.dumps(r.get("quality", {}), ensure_ascii=False)
            flat.append(row)
        return h.send_csv(flat, cols, f"ewoh_slice_{device_id}.csv")
    out = {
        "export_type": "raw_slice",
        "device_id": device_id,
        "start": start,
        "end": end,
        "format": fmt,
        "exported_at": now_iso(),
        "slice": slice_,
        "request_id": getattr(h, "_request_id", ""),
    }
    fname = f"ewoh_slice_{device_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return h.send_json(out, download=fname)


def route_export_post(ctx, h, req_meta):
    return api_export_post(ctx, h, req_meta.body)


DOMAIN_ROUTES = [
    Route("GET", "/api/telemetry", exact("/api/telemetry"), api_latest),
    Route("GET", "/api/telemetry/series", exact("/api/telemetry/series"), api_series),
    Route("GET", "/api/telemetry/export", exact("/api/telemetry/export"), api_export),
    Route("POST", "/api/telemetry/export", exact("/api/telemetry/export"), route_export_post),
]


def handle_telemetry(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
