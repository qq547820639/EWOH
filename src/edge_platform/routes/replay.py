#!/usr/bin/env python3
"""回放域路由（Task 9 / P2）。

当前 server.py 未暴露任何 /api/replay 或 world-model 回放 HTTP 端点
（历史回放为库能力：edge_platform/world_model/replay.py、scripts/replay_device.py），
故本模块保留空路由表并恒返回 NOT_HANDLED，仅用于维持 spec 约定的 8 个路由域结构。
"""

from . import NOT_HANDLED

DOMAIN_ROUTES = []


def handle_replay(ctx, h, req_meta):
    return NOT_HANDLED
