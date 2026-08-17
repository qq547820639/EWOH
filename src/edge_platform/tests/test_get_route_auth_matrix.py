"""审计 §4 主线 2 防回归门禁：边缘 GET 面鉴权「路由清单完整性」TCK（EDGE-001 簇）。

两条断言（2026-08-17 审计整改后钉死）：
1. **路由清单完整性**：枚举全部路由域 ``DOMAIN_ROUTES`` 的 GET 路由（/api/* 与
   /metrics），``rbac.action_for_request("GET", <具体化路径>)`` 对清单内每条
   路径必须返回非 None 动作——新增 GET 路由未映射 RBAC 动作即在本测试爆红
   （fail-closed：未映射路径 production 下会被 server 拒绝，但本测试把「新增
   路由必须显式映射动作」固化为门禁，防止靠 server 兜底掩盖清单漂移）。
2. **production 匿名全枚举 401**：真实装配 production server，对清单内全部
   GET 路由（{param} 以样本值具体化）逐一匿名请求，断言 401 + unauthorized
   （不允许任何一条 GET 路径无 token 返回业务数据）。

运行：PYTHONPATH=src python -m pytest src/edge_platform/tests/test_get_route_auth_matrix.py -q
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server  # noqa: E402  (先导入 server 解路由域循环依赖)
from edge_platform.config import Settings  # noqa: E402
from edge_platform.rbac.permissions import action_for_request  # noqa: E402
from edge_platform.routes import (  # noqa: E402
    admin,
    andon,
    auth,
    exo,
    health,
    inference,
    replay,
    scheduler,
    telemetry,
    world,
)

_ROUTE_DOMAINS = [health, inference, world, telemetry, scheduler, auth, admin, exo, replay, andon]

# 显式豁免登记（带审计理由）：production 下允许匿名访问的 GET 路径。
# 当前为空——EDGE-001 整改后 GET 面零匿名放行（静态资源/SPA 不在 DOMAIN_ROUTES）。
ANONYMOUS_GET_ALLOWLIST: dict[str, str] = {}


def _concretize(pattern: str) -> str:
    """把路由模式中的 {param} 占位符替换为样本值（如 /api/tasks/{id}* → /api/tasks/X*）。"""
    return re.sub(r"\{[^}]+\}", "X", pattern)


def _enumerate_get_routes() -> list[str]:
    """汇总全部路由域 DOMAIN_ROUTES 的 GET 路径模式（去重保序）。"""
    seen: list[str] = []
    for mod in _ROUTE_DOMAINS:
        for route in mod.DOMAIN_ROUTES:
            if route.method == "GET" and route.pattern not in seen:
                seen.append(route.pattern)
    return sorted(seen)


class GetRouteActionMatrixTest(unittest.TestCase):
    """纯函数层：路由清单内每条 GET 路径必须映射到 RBAC 动作。"""

    PATTERNS = _enumerate_get_routes()

    def test_route_manifest_not_empty(self):
        # 清单完整性前提：路由注册表确实被枚举（防止 import 演化后静默清空）。
        self.assertGreater(len(self.PATTERNS), 20, f"GET 路由清单异常: {self.PATTERNS}")

    def test_every_get_route_maps_to_action(self):
        unmapped = []
        for pattern in self.PATTERNS:
            concrete = _concretize(pattern)
            action = action_for_request("GET", concrete)
            if action is None and concrete not in ANONYMOUS_GET_ALLOWLIST:
                unmapped.append((pattern, concrete))
        self.assertEqual(
            unmapped,
            [],
            "以下 GET 路由未映射 RBAC 动作（production 下将被 fail-closed 拒绝；"
            "新增路由必须在 rbac.permissions.action_for_request 显式映射，"
            "或在此登记带审计理由的豁免）: " + repr(unmapped),
        )

    def test_mapped_actions_are_known(self):
        # 映射出的动作必须是权限矩阵内已知动作（防拼写漂移）。
        from edge_platform.rbac.permissions import ALL_ACTIONS

        unknown = []
        for pattern in self.PATTERNS:
            action = action_for_request("GET", _concretize(pattern))
            if action is not None and action not in ALL_ACTIONS:
                unknown.append((pattern, action))
        self.assertEqual(unknown, [], f"未知动作: {unknown}")


class _ProdFixture:
    """production 模式最小装配（与 test_rbac_enforcement 同构：Storage + repo + server）。"""

    def __init__(self):
        import tempfile
        import threading
        from pathlib import Path

        from edge_platform import run
        from edge_platform.edge.storage import Storage
        from edge_platform.scheduler.events import EventBus
        from edge_platform.scheduler.repository import SchedulingRepository

        self._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = "production"
        Settings.reset()
        self.tmp = tempfile.mkdtemp(prefix="ewoh_getmatrix_")
        self.storage = Storage(Path(self.tmp) / "matrix.db")
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage, readonly=False)
        self.event_bus = EventBus()
        self.scheduler, self.resource_state = run.build_scheduler(
            self.storage, self.repo, self.event_bus, mode="production"
        )
        self.ctx = server.Context(
            self.storage,
            scheduling_repository=self.repo,
            event_bus=self.event_bus,
            scheduler=self.scheduler,
            resource_state_service=self.resource_state,
        )
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def anonymous_get(self, path: str):
        import json
        import urllib.error
        import urllib.request

        base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        req = urllib.request.Request(base + path, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:  # nosec B310 - 本地测试客户端
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, (json.loads(raw) if raw else {})
            except json.JSONDecodeError:
                return e.code, {}

    def close(self):
        import shutil

        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        Settings.reset()
        os.environ.clear()
        os.environ.update(self._old_env)


class ProductionAnonymousGetDeniedTest(unittest.TestCase):
    """production 下对全部清单化 GET 路由匿名请求 → 401（EDGE-001 防回归）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ProdFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_all_manifest_get_routes_anonymous_401(self):
        leaked = []
        for pattern in _enumerate_get_routes():
            if pattern in ANONYMOUS_GET_ALLOWLIST or _concretize(pattern) in ANONYMOUS_GET_ALLOWLIST:
                continue
            status, body = self.fx.anonymous_get(_concretize(pattern))
            if status != 401:
                leaked.append((pattern, status, str(body)[:120]))
        self.assertEqual(
            leaked,
            [],
            "以下 GET 路由 production 匿名访问未返回 401（EDGE-001 回归）: " + repr(leaked),
        )


if __name__ == "__main__":
    unittest.main()
