#!/usr/bin/env python3
"""治理/管理域路由（Task 9 / P2）。

GET /api/audit（安全策略查询 /api/security/policy 归属 auth 域）。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

from . import Route, dispatch_routes, exact
from ._util import now_iso


def api_audit(ctx, h, req_meta):
    """GET /api/audit — 查询审计日志（?action=&actor_id=&limit=&offset= 分页）。"""
    action = h.arg("action") or None
    actor_id = h.arg("actor_id") or None
    limit, offset = h._limit(), h._offset()
    if not hasattr(ctx.storage, "list_audit_logs"):
        return h._new_error("storage_unavailable", "审计存储未就绪，拒绝伪造空审计", 503)
    try:
        items = ctx.storage.list_audit_logs(
            action=action, actor_id=actor_id, limit=limit, offset=offset
        )
    except Exception:
        return h._new_error("storage_unavailable", "审计存储查询失败", 503)
    return h.send_json({"items": items, "limit": limit, "offset": offset, "now": now_iso()})


DOMAIN_ROUTES = [
    Route("GET", "/api/audit", exact("/api/audit"), api_audit),
]


def handle_admin(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
