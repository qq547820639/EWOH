#!/usr/bin/env python3
"""Edge server 路由域包（Task 9 / P2：server.py 按 route domain 模块化）。

结构：
- 每个路由域模块（health / auth / telemetry / inference / world / scheduler /
  admin / replay）导出 ``handle_<domain>(ctx, h, req_meta) -> RouteOutcome``，
  内部通过本模块的 ``dispatch_routes`` 按声明顺序派发域内路由；
- ``registry.py`` 汇总各域的 ``DOMAIN_ROUTES`` 构建有序路由表，
  并提供 ``dispatch(ctx, h, method, req_meta)`` 供 server.py 调用；
- ``server.py`` 的 Handler 只保留横切中间件（请求 ID / CORS / body 上限 /
  审计 / 统一错误信封）与路由分发入口。

设计约束（与 spec Task 9 一致）：
- 只做机械抽取（原 Handler 方法 ``self.x`` → 传入的 ``h.x``、闭包 ``ctx`` →
  显式参数），不改变任何 HTTP 状态码、响应体、SSE 事件帧、CORS、认证顺序、
  审计顺序、错误信封与请求 ID 语义；
- 零运行时第三方依赖（仅 Python 标准库 + 平台既有模块）。
"""

from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple

# ---- RouteOutcome ----
# 未命中：返回 NOT_HANDLED，由 registry 依次尝试下一域，最后回退到 server.py
# 的默认行为（GET→静态文件、POST/PATCH→{"error":"not found"} 404）。
# 命中：路由 handler 已通过 h 写入完整响应，返回任意非 NOT_HANDLED 值
# （send_json 系返回 None；SSE 返回 STREAM）。
class _NotHandled:
    __slots__ = ()

    def __repr__(self):  # pragma: no cover - 仅便于调试
        return "NOT_HANDLED"


NOT_HANDLED = _NotHandled()
# SSE 流式响应标记：响应头与事件帧已由路由经 h 直接写入
STREAM = "stream"


@dataclass(frozen=True)
class ReqMeta:
    """路由分发所需的请求元数据（只读快照，构造一次）。

    注意：路由实现内仍沿用原 handler 的取值方式（h.arg()/h.path 等），
    path_parts/query 仅作分发辅助与文档用途，不改变原切片语义。
    """

    method: str
    path: str
    path_parts: Tuple[str, ...]
    query: Dict[str, list]
    body: Any
    headers: Any
    client: Tuple


class Route:
    """有序路由条目：match(path) 命中后调用 handle(ctx, h, req_meta)。"""

    __slots__ = ("method", "pattern", "match", "handle")

    def __init__(self, method: str, pattern: str, match: Callable[[str], bool], handle: Callable):
        self.method = method
        self.pattern = pattern  # 人类可读路径模式（含 {param} 占位符）
        self.match = match
        self.handle = handle


def exact(path: str) -> Callable[[str], bool]:
    """精确路径匹配（对应原 do_GET/do_POST 的 ``p == \"...\"`` 分支）。"""
    return lambda p: p == path


def sub_path(prefix: str) -> Callable[[str], bool]:
    """前缀子路径匹配：``p.startswith(prefix) and p != prefix``。

    与原 server.py 五处参数化 GET 路由（/api/tasks/、/api/scheduling/requests/、
    /api/scheduling/plans/、/api/devices/、/api/events/）的判定逐字一致，
    段数校验留在 handler 内完成（保持「段数不符 → 404 路径不存在」的既有语义）。
    """
    return lambda p: p.startswith(prefix) and p != prefix


def affix(prefix: str, suffix: str) -> Callable[[str], bool]:
    """前缀+后缀匹配：``p.startswith(prefix) and p.endswith(suffix)``。

    对应原 do_POST 的动作端点（/api/events/{id}/status、/api/events/{id}/comment、
    /api/scheduling/plans/{id}/confirm|execute|reject|replan、
    /api/assignments/{id}/start|pause|complete|cancel|override）。
    """
    return lambda p: p.startswith(prefix) and p.endswith(suffix)


def dispatch_routes(routes, ctx, h, req_meta):
    """按声明顺序派发域内路由：先按 method，再按 match(path)。

    命中即调用 route.handle(ctx, h, req_meta) 并返回其结果；
    未命中返回 NOT_HANDLED。
    """
    for route in routes:
        if route.method != req_meta.method:
            continue
        if route.match(req_meta.path):
            return route.handle(ctx, h, req_meta)
    return NOT_HANDLED
