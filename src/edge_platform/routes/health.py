#!/usr/bin/env python3
"""健康域路由（Task 9 / P2）。

GET /api/status、GET /metrics、GET /api/scheduler/v2/solver/health。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

import time

from edge_platform import services
from edge_platform.monitoring import PrometheusExporter
from edge_platform.scheduler.cpsat import solver as cpsat_solver

from . import Route, dispatch_routes, exact
from ._util import SOURCE_LABELS, now_iso


def _svc_health(svc, rules):
    """组件健康判定：对象存在且已 start（_running=True）才算 healthy。

    M3 修复：此前只检查对象存在（未启动仍报 healthy），导致健康检查误报。
    rules_only：推理服务未启动但规则引擎可用（设计内降级）。
    """
    if svc is None:
        return "not_running" if rules is None else "rules_only"
    if getattr(svc, "_running", False) is True:
        return "healthy"
    return "not_running" if rules is None else "rules_only"


def _ingest_chain(ctx):
    """ingest 链路健康（NO-05）：{ok, adapters_registered, adapters_healthy, details}。

    ok = 注册数 > 0 且存在 healthy 适配器；无注册（生产装配缺适配器注册入口 E-03
    的现状）时如实 false，绝不冒充正常。"""
    try:
        health = ctx.manager.health() if ctx.manager else []
    except Exception:
        health = []
    details = []
    healthy = 0
    for entry in health or []:
        status = entry.get("status")
        details.append(
            {
                "device_id": entry.get("device_id"),
                "status": status,
                "type": entry.get("type"),
            }
        )
        if status == "online" or status == "healthy":
            healthy += 1
    registered = len(health)
    return {
        "ok": registered > 0 and healthy > 0,
        "adapters_registered": registered,
        "adapters_healthy": healthy,
        "details": details,
    }


def api_status(ctx, h, req_meta):
    try:
        counts = ctx.storage.counts()
        db_ok = isinstance(counts, dict)
    except Exception:
        counts, db_ok = {}, False
    latency = {}
    if ctx.pipeline and hasattr(ctx.pipeline, "latency_stats"):
        try:
            latency = ctx.pipeline.latency_stats()
        except Exception:
            latency = {}
    model = {"active": None, "versions": [], "mode": "rules_only"}
    if ctx.registry:
        try:
            model = {
                "active": ctx.registry.active(),
                "versions": ctx.registry.versions(),
                "mode": "model" if ctx.registry.active() else "rules_only",
            }
        except Exception as e:  # L3：模型信息获取失败不报错，但记录
            print(f"[EWOH] model registry info failed: {e!r}")
    services_health = {
        "gateway": "healthy",  # 本 HTTP 网关
        "database": "healthy" if db_ok else "down",  # SQLite 持久层
        # M3 修复：如实报告运行状态（对象存在但未 start = 非 healthy），不再吞组件异常冒充健康
        "inference": _svc_health(ctx.pipeline, ctx.rules),
        "assistant": "healthy",  # 本地白名单助手，无外部依赖
        "adapters": _svc_health(ctx.manager, None),
    }
    # NO-05：ingest 链路诚实指标（E-03 防"真实模式空转"无感）：
    # 注册适配器数 + 健康适配器数 + 明细；ok = 已注册且有 healthy 适配器。
    ingest_chain = _ingest_chain(ctx)
    # NO-03c：遥测→世界模型投影健康（缺配置 enabled=false 如实上报）
    world_projection = (
        ctx.world_projection.health()
        if getattr(ctx, "world_projection", None) is not None
        else {"enabled": False}
    )
    # NO-04b：Edge→Cloud 事件上行健康（缺配置 enabled=false 如实上报）
    event_uplink = (
        ctx.event_uplink.health()
        if getattr(ctx, "event_uplink", None) is not None
        else {"enabled": False}
    )
    # 2026-09-10：多源传感器帧上行健康（缺配置 enabled=false 如实上报）
    sensor_uplink = (
        ctx.sensor_uplink.health()
        if getattr(ctx, "sensor_uplink", None) is not None
        else {"enabled": False}
    )
    # 2026-09-10：帧死信计数（不可归一化帧的权威留痕在 SQLite frame_dead_letter 表；
    # 这里只报计数——"0 条"必须有据可查，不能让健康页替存储说谎）。
    try:
        dead_letters = ctx.storage.count_frame_dead_letters()
    except Exception:
        dead_letters = None
    # NO-12d：Edge→Cloud 指标上行健康（缺配置 enabled=false 如实上报）
    metrics_uplink = (
        ctx.metrics_uplink.health()
        if getattr(ctx, "metrics_uplink", None) is not None
        else {"enabled": False}
    )
    return h.send_json(
        {
            "offline": True,
            "now": now_iso(),
            "uptime_sec": round(time.time() - ctx.started_at),
            "services": services_health,
            "db_counts": counts,
            "latency": latency,
            "model": model,
            "rule_version": getattr(ctx.rules, "rule_version", None),
            "listeners": getattr(ctx.manager, "listeners", {}),
            "source_labels": SOURCE_LABELS,
            "ingest_chain": ingest_chain,
            "world_projection": world_projection,
            "event_uplink": event_uplink,
            "metrics_uplink": metrics_uplink,
            "sensor_uplink": sensor_uplink,
            "frame_dead_letters": dead_letters,
            "safety_boundary": "平台与大模型不得写入急停、限扭、关节实时控制等安全闭环参数。",
        }
    )


def _refresh_device_stats(ctx, h):
    """根据当前设备/遥测态刷新 MetricsCollector 的设备级指标。

    - online/offline：基于 device_online 双重判定
    - low_battery：最近遥测 load_score 不参与；以 telemetry.battery_level < 20 计
    - avg_packet_loss_pct：取最近遥测 packet_loss_pct 的均值（缺失视为 0）
    """
    if ctx.metrics is None:
        return
    devices = ctx.storage.list_devices()
    online = sum(1 for d in devices if ctx.device_online(d))
    offline = len(devices) - online
    low_battery, loss_values = 0, []
    for d in devices:
        rec = services.norm_telemetry(ctx.storage.latest_telemetry(d.get("device_id")))
        if not rec:
            continue
        tel = rec.get("telemetry") or {}
        batty = tel.get("battery_pct", tel.get("battery_percent", tel.get("battery_level")))
        try:
            if batty is not None and float(batty) < 20:
                low_battery += 1
        except (TypeError, ValueError):
            pass
        loss = tel.get("packet_loss_pct")
        try:
            if loss is not None:
                loss_values.append(float(loss))
        except (TypeError, ValueError):
            pass
    avg_loss = (sum(loss_values) / len(loss_values)) if loss_values else 0.0
    ctx.metrics.set_device_stats(online, offline, avg_packet_loss_pct=avg_loss, low_battery_count=low_battery)


def send_metrics(ctx, h, req_meta):
    """Task 33：Prometheus exposition format（text/plain; version=0.0.4）。"""
    if ctx.metrics is None:
        return h.send_json({"error": "metrics collector 未启用"}, 503)
    _refresh_device_stats(ctx, h)
    text = PrometheusExporter().format_prometheus(ctx.metrics.snapshot())
    data = text.encode("utf-8")
    h.send_response(200)
    h.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
    h.wfile.write(data)


def route_solver_health(ctx, h, req_meta):
    return h.send_json(
        {
            "ok": True,
            "available": cpsat_solver.is_available(),
            "solverVersion": "cpsat-v1",
        }
    )


DOMAIN_ROUTES = [
    Route("GET", "/api/status", exact("/api/status"), api_status),
    Route("GET", "/metrics", exact("/metrics"), send_metrics),
    Route("GET", "/api/scheduler/v2/solver/health", exact("/api/scheduler/v2/solver/health"), route_solver_health),
]


def handle_health(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
