#!/usr/bin/env python3
"""路由注册表（Task 9 / P2）：按 route domain 汇总有序路由表并提供统一分发。

优先级说明（与重构前 server.py 的 do_GET/do_POST/do_PATCH 分支顺序逐字对齐）：
- 域内顺序：各域 DOMAIN_ROUTES 保持原 if 链顺序——精确路径在前、参数路径在后
  （例如 /api/tasks/assignments 先于 /api/tasks/{id}，/api/devices 先于
  /api/devices/{id}），保证「同时命中精确路径与参数模式」时行为不变；
- 域间顺序：不同域的精确路径互不重叠（无跨域前缀遮蔽），域间顺序仅影响
  文档可读性，不影响匹配结果；POST 的 world 域排在 scheduler 之前，对应原
  do_POST 中 /api/event/status、/api/events/{id}/status|comment 先于调度端点。
"""

from . import NOT_HANDLED
from .actuators import handle_actuators
from .admin import handle_admin
from .andon import handle_andon
from .auth import handle_auth
from .exo import handle_exo
from .health import handle_health
from .inference import handle_inference
from .replay import handle_replay
from .scheduler import handle_scheduler
from .telemetry import handle_telemetry
from .world import handle_world

# 每方法的域调度顺序（与重构前各 do_* 的判序语义一致）
ROUTE_TABLE = {
    "GET": [
        handle_health,
        handle_inference,
        handle_world,
        handle_telemetry,
        handle_scheduler,
        handle_auth,
        handle_admin,
        handle_exo,
        handle_actuators,
        handle_replay,
    ],
    "POST": [
        handle_world,
        handle_scheduler,
        handle_inference,
        handle_telemetry,
        handle_auth,
        handle_exo,
        handle_andon,
        handle_actuators,
        handle_replay,
    ],
    "PATCH": [
        handle_scheduler,
        handle_replay,
    ],
}


def dispatch(ctx, h, method, req_meta):
    """按方法依次尝试各路由域；命中（返回非 NOT_HANDLED）即返回，否则 NOT_HANDLED。"""
    for domain in ROUTE_TABLE.get(method, ()):
        outcome = domain(ctx, h, req_meta)
        if outcome is not NOT_HANDLED:
            return outcome
    return NOT_HANDLED
