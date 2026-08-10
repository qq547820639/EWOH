#!/usr/bin/env python3
"""路由域共享工具（Task 9 / P2）。

自原 server.py 模块级辅助函数机械搬移（self→h、ctx 显式传参），
不改变任何业务语义；集中放置以避免路由域模块与 server.py 之间的循环导入。
"""

from datetime import datetime, timedelta

from edge_platform import services
from edge_platform.config import Settings

# 离线判定 / 证据窗口 / 来源标识（原 server.py 模块级常量）
OFFLINE_AFTER_SEC = Settings.load().offline_after_sec
EVIDENCE_WINDOW_SEC = Settings.load().evidence_window_sec
SOURCE_LABELS = {"real": "REAL DEVICE", "controlled_test": "受控数据", "simulated": "模拟数据"}

parse_ts = services.parse_ts


def now_iso():
    return services.iso(datetime.now())


def _device_view(ctx, d):
    v = dict(d)
    v["online"] = ctx.device_online(d)
    v["source_label"] = SOURCE_LABELS.get(d.get("source_type"), d.get("source_type"))
    return v


def _filter_source(items, source):
    if source in SOURCE_LABELS:
        return [x for x in items if x.get("source_type") == source]
    return items


def _latest_state(ctx, device_id):
    """实时态：最新一条遥测 + 最近推理结果。"""
    rec = services.norm_telemetry(ctx.storage.latest_telemetry(device_id))
    if not rec:
        return None
    end = parse_ts(rec.get("timestamp")) or datetime.now().astimezone()
    inf = ctx.storage.query_inference(
        device_id, services.iso(end - timedelta(seconds=10)), services.iso(end + timedelta(seconds=1)), 1
    )
    rec["inference"] = services.norm_inference(inf[-1]) if inf else None
    rec["source_label"] = SOURCE_LABELS.get(rec.get("source_type"), rec.get("source_type"))
    rec["mode"] = "realtime"
    return rec


def session_manager():
    """晚绑定 server._get_session_manager（调用时经 server 模块解析）。

    兼容 test_auth_failclosed 对 ``server._get_session_manager`` 的 monkeypatch：
    仅当请求处理时才解引用，保证测试注入的 ``lambda: None`` 生效。
    """
    from edge_platform import server

    return server._get_session_manager()
