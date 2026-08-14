#!/usr/bin/env python3
"""推理/模型/知识域路由（Task 9 / P2）。

GET /api/inference、/api/inference/metrics、/api/person/profile、/api/models、
/api/rules、/api/demo/guide；POST /api/query、/api/scenario/evaluate、
/api/vision/understand。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

from datetime import datetime, timedelta

from edge_platform import services

from . import Route, dispatch_routes, exact
from ._util import _device_view, _latest_state, now_iso, parse_ts

# Task 19 演示指引（原 server.py 模块级 DEMO_STEPS）
DEMO_STEPS = [
    {
        "step": 1,
        "name": "断公网展示本地服务",
        "panel": "health",
        "hint": "拔掉外网后系统健康页全部本地服务保持 healthy",
    },
    {"step": 2, "name": "真机上线与人员绑定", "panel": "devices", "hint": "设备管理页出现 REAL DEVICE 标识与绑定人员"},
    {"step": 3, "name": "真人站立/行走/弯腰/搬举", "panel": "realtime", "hint": "实时态势页动作标签随真人动作变化"},
    {
        "step": 4,
        "name": "触发安全可控风险事件",
        "panel": "events",
        "hint": "事件中心出现结构化事件，可查看前后 30 秒证据",
    },
    {"step": 5, "name": "本地查询事件与人员状态", "panel": "assistant", "hint": "本地助手引用真实记录回答白名单问题"},
    {
        "step": 6,
        "name": "输入客户场景生成试点建议",
        "panel": "scenario",
        "hint": "场景评估器输出一页纸与捷顺下一步请求",
    },
]


def api_inference_metrics(ctx, h, req_meta):
    """Task 33：推理延迟/吞吐/unknown 占比 JSON。

    优先取 MetricsCollector 的累计统计；若未注入则回落到 pipeline.latency_stats()。
    """
    now = datetime.now().astimezone()
    start = parse_ts(h.arg("start")) or (now - timedelta(hours=24))
    end = parse_ts(h.arg("end")) or now
    limit = int(h.arg("limit", "5000") or 5000)
    # 从持久层统计 unknown 占比（按时间段）
    inf_rows = []
    try:
        for d in ctx.storage.list_devices():
            inf_rows.extend(
                ctx.storage.query_inference(d.get("device_id"), services.iso(start), services.iso(end), limit)
            )
    except Exception:
        inf_rows = []
    total = len(inf_rows)
    unknown = sum(1 for r in inf_rows if (r.get("label") == "unknown"))
    unknown_ratio = round(unknown / total, 4) if total else 0.0
    # 延迟优先用 collector 累计值（覆盖所有历史样本），其次用 pipeline.latency_stats
    p50_ms = p95_ms = None
    count = 0
    if ctx.metrics is not None:
        snap = ctx.metrics.snapshot()
        count = snap.get("inference_count", 0)
        p50_ms = snap.get("inference_p50_ms")
        p95_ms = snap.get("inference_p95_ms")
        errors = snap.get("error_count", 0)
        unknown_total = snap.get("unknown_count", 0)
    else:
        errors = 0
        unknown_total = 0
    if ctx.pipeline is not None:
        try:
            if hasattr(ctx.pipeline, "latency_stats"):
                lat = ctx.pipeline.latency_stats() or {}
            elif hasattr(ctx.pipeline, "metrics"):
                lat = ctx.pipeline.metrics() or {}
            else:
                lat = {}
        except Exception:
            lat = {}
        if p50_ms is None:
            p50_ms = lat.get("p50_ms") or lat.get("p50")
        if p95_ms is None:
            p95_ms = lat.get("p95_ms") or lat.get("p95")
        if not count:
            count = lat.get("count", 0)
    # 吞吐：按查询窗口内推理数估算每秒吞吐
    window_sec = max(1.0, (end - start).total_seconds())
    throughput_per_sec = round(total / window_sec, 4)
    return h.send_json(
        {
            "now": now_iso(),
            "window": {"start": services.iso(start), "end": services.iso(end)},
            "inference_count": count,
            "window_inference_count": total,
            "inference_p50_ms": p50_ms,
            "inference_p95_ms": p95_ms,
            "throughput_per_sec": throughput_per_sec,
            "unknown_count": unknown_total,
            "window_unknown_count": unknown,
            "unknown_ratio": unknown_ratio,
            "error_count": errors,
            "source": "metrics_collector" if ctx.metrics is not None else "pipeline",
        }
    )


def api_inference(ctx, h, req_meta):
    device_id = h.arg("device_id")
    now = datetime.now().astimezone()
    start = parse_ts(h.arg("start")) or (now - timedelta(hours=24))
    end = parse_ts(h.arg("end")) or now
    limit = int(h.arg("limit", "200") or 200)
    items = [
        services.norm_inference(r)
        for r in ctx.storage.query_inference(device_id, services.iso(start), services.iso(end), limit)
    ]
    return h.send_json({"items": items, "now": now_iso()})


def api_profile(ctx, h, req_meta):
    """单人作业画像：人员 + 绑定设备 + 当前状态 + 24h 动作分布 + 未处置事件。"""
    pid = h.arg("person_id")
    person = next((p for p in ctx.storage.list_people() if p.get("person_id") == pid), None)
    if not person:
        return h.send_json({"error": "人员不存在"}, 404)
    dev = next((d for d in ctx.storage.list_devices() if d.get("person_id") == pid), None)
    now = datetime.now().astimezone()
    dist, latest, quality = {}, None, "unknown"
    if dev:
        latest = _latest_state(ctx, dev["device_id"])
        quality = (latest or {}).get("quality", {}).get("status", "unknown")
        start = services.iso(now - timedelta(hours=24))
        for r in ctx.storage.query_inference(dev["device_id"], start, services.iso(now), 2000):
            r = services.norm_inference(r)
            dist[r.get("label", "unknown")] = dist.get(r.get("label", "unknown"), 0) + 1
    metrics = services.person_metrics(ctx.storage, person, dev)
    events = [
        services.norm_event(e)
        for e in ctx.storage.list_events(100)
        if services.norm_event(e).get("person_id") == pid
    ]
    return h.send_json(
        {
            "person": person,
            "skills": services.person_skills(person),
            "device": _device_view(ctx, dev) if dev else None,
            "latest": latest,
            "action_distribution_24h": dist,
            "metrics": metrics,
            "events": events[:10],
            "quality": quality,
            "now": now_iso(),
        }
    )


def api_models(ctx, h, req_meta):
    """GET /api/models — 查询已注册模型列表。"""
    limit, offset = h._limit(), h._offset()
    items = ctx.storage.list_models() if hasattr(ctx.storage, "list_models") else []
    return h.send_json(
        {"items": items[offset : offset + limit], "limit": limit, "offset": offset, "now": now_iso()}
    )


def api_rules(ctx, h, req_meta):
    """GET /api/rules — 查询已注册规则列表。"""
    limit, offset = h._limit(), h._offset()
    items = ctx.storage.list_rules() if hasattr(ctx.storage, "list_rules") else []
    return h.send_json(
        {"items": items[offset : offset + limit], "limit": limit, "offset": offset, "now": now_iso()}
    )


def route_demo_guide(ctx, h, req_meta):
    return h.send_json({"steps": DEMO_STEPS})


def route_query(ctx, h, req_meta):
    h.send_json(
        services.answer(ctx.storage, req_meta.body.get("question", ""), ctx.device_online, ctx.assignments)
    )


def route_scenario_evaluate(ctx, h, req_meta):
    h.send_json(services.evaluate_scenario(req_meta.body))


def api_vision_understand(ctx, h, payload):
    """POST /api/vision/understand — 视觉理解（演示模式默认后端：Ark）。

    body: {image_url?, question?, api_key?, base_url?, model?}。
    image_url 缺省时使用演示模式默认图，question 缺省为"你看见了什么？"。
    api_key/base_url/model 为可选的请求级覆盖（优先级高于环境变量），
    用于前端设置里管理员填写/替换演示用的方舟密钥。未配置 API Key 时返回明确错误。
    """
    from edge_platform.perception.ark_vision import describe_image

    image_url = (payload.get("image_url") or "").strip()
    question = (payload.get("question") or "").strip()
    api_key = (payload.get("api_key") or "").strip()
    base_url = (payload.get("base_url") or "").strip()
    model = (payload.get("model") or "").strip()
    h._audit_target_type = "vision"
    h._audit_target_id = (image_url or "demo_default")[:120]
    result = describe_image(image_url, question, api_key=api_key, base_url=base_url, model=model)
    if not result.get("ok"):
        return h.send_json(
            {
                "ok": False,
                "backend": result.get("backend", "ark"),
                "error": result.get("error", "视觉理解失败"),
                "now": now_iso(),
            },
            502,
        )
    return h.send_json(
        {
            "ok": True,
            "backend": result.get("backend", "ark"),
            "model": result.get("model"),
            "answer": result.get("answer", ""),
            "now": now_iso(),
        }
    )


def route_vision_understand(ctx, h, req_meta):
    return api_vision_understand(ctx, h, req_meta.body)


DOMAIN_ROUTES = [
    Route("GET", "/api/inference/metrics", exact("/api/inference/metrics"), api_inference_metrics),
    Route("GET", "/api/inference", exact("/api/inference"), api_inference),
    Route("GET", "/api/person/profile", exact("/api/person/profile"), api_profile),
    Route("GET", "/api/models", exact("/api/models"), api_models),
    Route("GET", "/api/rules", exact("/api/rules"), api_rules),
    Route("GET", "/api/demo/guide", exact("/api/demo/guide"), route_demo_guide),
    Route("POST", "/api/query", exact("/api/query"), route_query),
    Route("POST", "/api/scenario/evaluate", exact("/api/scenario/evaluate"), route_scenario_evaluate),
    Route("POST", "/api/vision/understand", exact("/api/vision/understand"), route_vision_understand),
]


def handle_inference(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
