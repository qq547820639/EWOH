"""2026-08-19 审计 P1 防回归门禁：边缘写面（POST/PATCH）鉴权「路由清单完整性」TCK。

背景：do_POST 的 RBAC 校验原为 `if action and not rbac_allowed(...)`——
``action_for_request("POST", p)`` 返回 None（未映射）时静默放行（fail-open），
如 /api/scheduler/v2/solve 触发 CP-SAT 求解却完全绕过角色矩阵。整改后：
1. permissions._action_for_write 补齐 /api/scheduler/* 与 /api/telemetry/export 映射；
2. server.do_POST / do_PATCH 对未映射的 /api/* 写路径 fail-closed 401
   （与 GET 读守卫同款语义）。

本测试钉死两条断言：
1. **路由清单完整性**：枚举全部路由域 DOMAIN_ROUTES 的 POST/PATCH 路由，
   ``rbac.action_for_request("POST", <具体化路径>)`` 对清单内每条路径必须返回
   非 None 动作（公共认证端点白名单除外）——新增写路由未映射 RBAC 动作即爆红；
2. **production 已认证用户访问未映射写路径 → 401**（fail-closed 生效自证）；
3. **production 已认证 operator 访问 /api/scheduler/v2/solve → 403**（此前
   fail-open 完全放行，现按 manage_assignments 矩阵拦截）。

运行：PYTHONPATH=src python -m pytest src/edge_platform/tests/test_write_route_auth_matrix.py -q
"""

import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

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

# 显式豁免登记（带审计理由）：production 下不经 RBAC 动作映射的写路径。
# 仅认证类公共端点（登录/换发——匿名可用，登录后才获得角色）。
WRITE_ACTION_ALLOWLIST: dict[str, str] = {
    "/api/auth/login": "认证端点：匿名可用，登录后才获得角色",
    "/api/auth/refresh": "认证端点：匿名可用，登录后才获得角色",
}


def _concretize(pattern: str) -> str:
    """把路由模式中的 {param} 占位符替换为样本值（如 /api/tasks/{id} → /api/tasks/X）。"""
    return re.sub(r"\{[^}]+\}", "X", pattern)


def _enumerate_write_routes() -> list[tuple[str, str]]:
    """汇总全部路由域 DOMAIN_ROUTES 的 POST/PATCH 路径（method, pattern，去重保序）。"""
    seen: list[tuple[str, str]] = []
    for mod in _ROUTE_DOMAINS:
        for route in mod.DOMAIN_ROUTES:
            if route.method in ("POST", "PATCH", "PUT", "DELETE"):
                key = (route.method, route.pattern)
                if key not in seen:
                    seen.append(key)
    return sorted(seen)


class WriteRouteActionMatrixTest(unittest.TestCase):
    """纯函数层：路由清单内每条写路径必须映射到 RBAC 动作（或登记豁免）。"""

    ROUTES = _enumerate_write_routes()

    def test_route_manifest_not_empty(self):
        # 清单完整性前提：写路由注册表确实被枚举（防止 import 演化后静默清空）。
        self.assertGreater(len(self.ROUTES), 15, f"写路由清单异常: {self.ROUTES}")

    def test_every_write_route_maps_to_action(self):
        unmapped = []
        for method, pattern in self.ROUTES:
            concrete = _concretize(pattern)
            if concrete in WRITE_ACTION_ALLOWLIST:
                continue
            action = action_for_request(method, concrete)
            if action is None:
                unmapped.append((method, pattern, concrete))
        self.assertEqual(
            unmapped,
            [],
            "以下写路由未映射 RBAC 动作（production 下将被 fail-closed 拒绝；"
            "新增路由必须在 rbac.permissions._action_for_write 显式映射，"
            "或在此登记带审计理由的豁免）: " + repr(unmapped),
        )

    def test_mapped_actions_are_known(self):
        from edge_platform.rbac.permissions import ALL_ACTIONS

        unknown = []
        for method, pattern in self.ROUTES:
            concrete = _concretize(pattern)
            action = action_for_request(method, concrete)
            if action is not None and action not in ALL_ACTIONS:
                unknown.append((method, pattern, action))
        self.assertEqual(unknown, [], f"未知动作: {unknown}")

    def test_scheduler_solve_maps_to_manage_assignments(self):
        """P1 审计点名路径：/api/scheduler/v2/solve → manage_assignments。"""
        self.assertEqual(
            action_for_request("POST", "/api/scheduler/v2/solve"), "manage_assignments"
        )

    def test_telemetry_export_post_maps_to_export_data(self):
        self.assertEqual(action_for_request("POST", "/api/telemetry/export"), "export_data")


class _ProdFixture:
    """production 模式最小装配（与 test_rbac_enforcement 同构）。"""

    def __init__(self):
        from edge_platform import run
        from edge_platform.edge.storage import Storage
        from edge_platform.scheduler.events import EventBus
        from edge_platform.scheduler.repository import SchedulingRepository

        self._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = "production"
        # D14（2026-08-19 审计）：production 种子口令强制环境变量置换。
        os.environ["EWOH_SEED_ADMIN_PASSWORD"] = "prod-admin-pw-1"
        os.environ["EWOH_SEED_SAFETY_PASSWORD"] = "prod-safety-pw-1"
        os.environ["EWOH_SEED_OPERATOR_PASSWORD"] = "prod-operator-pw-1"
        Settings.reset()
        # 进程级校验器缓存按首次构造环境派生（test_auth 同款隔离模式）——
        # 不重置则沿用前序测试文件派生的口令，本 fixture 的口令全部失效。
        from edge_platform.auth.identity import OfflineIdentityBackend

        OfflineIdentityBackend._seed_verifiers = None
        self.tmp = tempfile.mkdtemp(prefix="ewoh_writematrix_")
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
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def login(self, username, password):
        req = urllib.request.Request(
            self.base + "/api/auth/login",
            data=json.dumps({"username": username, "password": password}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:  # nosec B310 - 本地测试客户端
            return json.loads(r.read())["token"]

    def req(self, method, path, body=None, token=None):
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:  # nosec B310 - 本地测试客户端
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def close(self):
        import shutil

        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        Settings.reset()
        # 校验器缓存重置：避免本 fixture 的 prod 口令污染后续测试文件。
        from edge_platform.auth.identity import OfflineIdentityBackend

        OfflineIdentityBackend._seed_verifiers = None
        os.environ.clear()
        os.environ.update(self._old_env)


class ProductionWriteFailClosedTest(unittest.TestCase):
    """production 下写面 fail-closed 生效自证（认证用户 + RBAC 矩阵）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ProdFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_authenticated_unmapped_write_path_denied_401(self):
        """P1 核心：已认证用户访问未映射写路径 → 401（原 fail-open 放行到派发层）。"""
        token = self.fx.login("admin", "prod-admin-pw-1")
        status, body = self.fx.req("POST", "/api/no-such-write", {}, token=token)
        self.assertEqual(status, 401, f"未映射写路径应 fail-closed 401: {body}")
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_operator_scheduler_solve_forbidden_403(self):
        """P1 审计点名场景：operator 触发求解 → 403（原完全绕过 RBAC）。"""
        token = self.fx.login("operator", "prod-operator-pw-1")
        status, body = self.fx.req("POST", "/api/scheduler/v2/solve", {}, token=token)
        self.assertEqual(status, 403, f"operator 无 manage_assignments 应 403: {body}")
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_scheduler_solve_reaches_domain_for_admin(self):
        """admin 有 manage_assignments——请求穿过 RBAC 到达领域层（非 401/403）。"""
        token = self.fx.login("admin", "prod-admin-pw-1")
        status, body = self.fx.req("POST", "/api/scheduler/v2/solve", {}, token=token)
        self.assertNotEqual(status, 401, f"admin 求解不应被认证层拦截: {body}")
        self.assertNotEqual(status, 403, f"admin 求解不应被 RBAC 拦截: {body}")


if __name__ == "__main__":
    unittest.main()
