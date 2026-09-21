"""P0-Edge-Security 回归测试。

覆盖 Edge server.py 三项安全闭环：
1. CORS：production 仅显式 allowlist；未命中 Origin 不回送 CORS 头（fail-closed）；
   development 保留 echo 但属开发回退。
2. 认证：production 下写操作（POST）未认证 → 401（禁止 anonymous fallback）；
   公共端点（/api/auth/login）豁免。
3. 错误脱敏：500 类内部异常不对外透传 str(e)，返回稳定
   {code: internal_error, message, request_id}；详情只进内部日志。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_edge_security -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server  # noqa: E402


class _ProductionServerFixture:
    """以 production 模式装配真实 server（runtime mode 由测试显式控制）。"""

    def __init__(self, runtime_mode="production", cors_origins=""):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sec_")
        self._old_env = {}
        self._set_env("EWOH_RUNTIME_MODE", runtime_mode)
        self._set_env("EWOH_CORS_ORIGINS", cors_origins)
        self._set_env("EWOH_SEED_ADMIN_PASSWORD", "security-admin-7f2!")
        self._set_env("EWOH_SEED_SAFETY_PASSWORD", "security-safety-9c4!")
        self._set_env("EWOH_SEED_OPERATOR_PASSWORD", "security-operator-1d8!")
        # Settings 是单例缓存，必须重置使本次 env 生效
        from edge_platform.config import Settings

        Settings.reset()

        from edge_platform.edge.bus import MessageBus
        from edge_platform.edge.storage import Storage
        from edge_platform.inference.model import ModelRegistry
        from edge_platform.inference.pipeline import InferencePipeline
        from edge_platform.inference.rules import RuleEngine

        self.db_path = Path(self.tmp) / "sec.db"
        self.storage = Storage(self.db_path)
        bus = MessageBus()
        registry = ModelRegistry(Path(self.tmp) / "models")
        rules = RuleEngine("risk-rule-v0.2", {})
        pipeline = InferencePipeline(self.storage, bus, registry, rules)
        from edge_platform.edge.manager import AdapterManager

        manager = AdapterManager(self.storage, bus, listeners={})
        self.ctx = server.Context(
            self.storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager
        )
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def _set_env(self, key, value):
        self._old_env[key] = os.environ.get(key)
        if value:
            os.environ[key] = value
        elif key in os.environ:
            del os.environ[key]

    def close(self):
        self.httpd.shutdown()
        self.thread.join(timeout=2)
        for key, val in self._old_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        # 恢复 Settings 单例：避免 production env 污染后续按字母序运行的测试类
        from edge_platform.config import Settings

        Settings.reset()

    def req(self, path, method="GET", body=None, headers=None, allow_redirect=True):
        data = json.dumps(body).encode() if body is not None else None
        h = dict(headers or {})
        if body is not None:
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            resp = urllib.request.urlopen(r, timeout=5)  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
            return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def login(self, username="admin", password="security-admin-7f2!"):
        """登录获取 Bearer token（EDGE-001 整改后 production GET 面需要认证）。"""
        status, _, body = self.req(
            "/api/auth/login", method="POST", body={"username": username, "password": password}
        )
        if status == 200:
            return json.loads(body)["token"]
        return None


class CORSProductionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # production + 显式 allowlist
        cls.fx = _ProductionServerFixture(
            runtime_mode="production", cors_origins="http://localhost:5173,https://app.ewoh.example"
        )

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_allowed_origin_gets_cors_headers(self):
        token = self.fx.login()
        status, headers, _ = self.fx.req(
            "/api/devices",
            headers={"Origin": "https://app.ewoh.example", "Authorization": f"Bearer {token}"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://app.ewoh.example")
        self.assertEqual(headers.get("Access-Control-Allow-Credentials"), "true")

    def test_disallowed_origin_gets_no_cors_headers(self):
        token = self.fx.login()
        status, headers, _ = self.fx.req(
            "/api/devices",
            headers={"Origin": "https://evil.example", "Authorization": f"Bearer {token}"},
        )
        self.assertEqual(status, 200)  # 请求本身可处理（同源语义），但不回送 CORS 头
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertIsNone(headers.get("Access-Control-Allow-Credentials"))

    def test_no_origin_gets_no_cors_headers(self):
        token = self.fx.login()
        status, headers, _ = self.fx.req("/api/devices", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))


class CORSProductionNoAllowlistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # production 但未配置 allowlist → 任何跨域请求都不回送 CORS 头（fail-closed）
        cls.fx = _ProductionServerFixture(runtime_mode="production", cors_origins="")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_production_without_allowlist_rejects_all_cors(self):
        token = self.fx.login()
        for origin in ("http://localhost:5173", "https://app.ewoh.example"):
            status, headers, _ = self.fx.req(
                "/api/devices", headers={"Origin": origin, "Authorization": f"Bearer {token}"}
            )
            self.assertEqual(status, 200)
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))


class ProductionAuthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ProductionServerFixture(runtime_mode="production")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_production_post_without_token_rejected(self):
        # 写操作未认证 → 401（禁止 anonymous 写入）
        status, _, body = self.fx.req(
            "/api/tasks", method="POST", body={"task_id": "T1", "task_type": "搬运"}
        )
        self.assertEqual(status, 401, body)
        err = json.loads(body)
        self.assertEqual(err["error"]["code"], "unauthorized")

    def test_production_post_invalid_token_rejected(self):
        status, _, body = self.fx.req(
            "/api/tasks",
            method="POST",
            body={"task_id": "T2"},
            headers={"Authorization": "Bearer invalid-token"},
        )
        self.assertEqual(status, 401, body)

    def test_production_public_login_path_exempt(self):
        # EDT-006：/api/auth/login 是公共端点——钉死状态码语义：
        # 正确凭证 → 200；错误凭证 → 401 invalid_credentials（业务层，非认证门禁）。
        status, _, body = self.fx.req(
            "/api/auth/login",
            method="POST",
            body={"username": "admin", "password": "security-admin-7f2!"},
        )
        self.assertEqual(status, 200, body)
        self.assertIn("token", json.loads(body))

        status, _, body = self.fx.req(
            "/api/auth/login",
            method="POST",
            body={"username": "admin", "password": "wrong-password"},
        )
        self.assertEqual(status, 401, body)
        self.assertEqual(json.loads(body)["error"]["code"], "invalid_credentials")

    def test_production_get_requires_token(self):
        # EDGE-001（2026-08-17 审计整改）：production 下 GET 业务数据面不再匿名放行
        status, _, body = self.fx.req("/api/devices")
        self.assertEqual(status, 401, body)
        err = json.loads(body)
        self.assertEqual(err["error"]["code"], "unauthorized")

    def test_production_get_with_token_allowed(self):
        # EDGE-001：携带有效 token 的 GET 按 VIEW_* 动作放行
        token = self.fx.login()
        self.assertIsNotNone(token)
        status, _, _ = self.fx.req("/api/devices", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(status, 200)


class DevelopmentAuthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ProductionServerFixture(runtime_mode="development")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_development_post_without_token_allowed(self):
        # development 保持向后兼容：写操作不被 401 认证拦截（演示/联调可匿名）。
        # 本 fixture 未装配 scheduler，业务层返回 503 not_ready——重点是不出现 401 unauthorized。
        status, _, body = self.fx.req(
            "/api/tasks", method="POST", body={"task_id": "T-DEV", "task_type": "搬运"}
        )
        self.assertNotEqual(status, 401, body)
        err = json.loads(body)
        self.assertNotEqual(err["error"]["code"], "unauthorized", body)


class ErrorRedactionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ProductionServerFixture(runtime_mode="production")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_internal_error_does_not_leak_exception_detail(self):
        # EDT-002：真实触达 500 路径——注入 storage 故障，认证 GET /api/devices
        # 抛内部异常；断言响应为稳定 internal_error 信封且不泄露 str(e) 详情。
        token = self.fx.login()
        secret_marker = "SECRET-INTERNAL-DETAIL-XYZ"

        def boom():
            raise RuntimeError(secret_marker)

        self.fx.ctx.storage.list_devices = boom
        try:
            status, _, body = self.fx.req(
                "/api/devices", headers={"Authorization": f"Bearer {token}"}
            )
        finally:
            del self.fx.ctx.storage.list_devices  # 还原类方法
        self.assertEqual(status, 500, body)
        err = json.loads(body)
        self.assertEqual(err["error"]["code"], "internal_error")
        self.assertEqual(err["error"]["message"], "请求处理失败")
        self.assertNotIn(secret_marker, body.decode("utf-8"), "500 响应不得泄露内部异常详情")

    def test_error_response_shape_is_stable(self):
        # 认证失败响应为稳定 {code,message,request_id} 结构
        status, _, body = self.fx.req(
            "/api/tasks", method="POST", body={"task_id": "T4"}
        )
        self.assertEqual(status, 401)
        err = json.loads(body)
        self.assertEqual(set(err["error"].keys()), {"code", "message", "request_id"})
        self.assertTrue(err["error"]["request_id"])


if __name__ == "__main__":
    unittest.main()
