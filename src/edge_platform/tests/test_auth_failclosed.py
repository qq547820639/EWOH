"""A4 回归测试：production 下 auth 未就绪时登录 fail-closed（不生成演示 token）。

背景：api_auth_login 在 auth 模块未就绪（sm is None）时，对任意用户名/密码
生成演示 admin token（24h）。production 下这是认证降级风险。修复后：
- production → 503（code=auth_unavailable），不生成任何 token；
- development/simulation → 保留演示 token（离线演示是设计内功能）。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_auth_failclosed -v
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
from edge_platform.config import Settings  # noqa: E402
from edge_platform.edge.storage import Storage  # noqa: E402


class _AuthFixture:
    """按 runtime_mode 装配 server，并强制 auth 模块未就绪（sm is None）。"""

    def __init__(self, runtime_mode):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_auth_")
        self._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = runtime_mode
        Settings.reset()

        self.storage = Storage(Path(self.tmp) / "auth.db")
        self.storage.init_db()
        self.ctx = server.Context(self.storage)
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

        # 强制 auth 模块未就绪：模拟 sm is None 的降级路径
        self._orig = server._get_session_manager
        server._get_session_manager = lambda: None

    def close(self):
        server._get_session_manager = self._orig
        self.httpd.shutdown()
        self.thread.join(timeout=2)
        self.storage.close()
        os.environ.clear()
        os.environ.update(self._old_env)
        Settings.reset()

    def login(self, username="admin", password="admin123"):
        data = json.dumps({"username": username, "password": password}).encode()
        req = urllib.request.Request(
            self.base + "/api/auth/login", data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            resp = urllib.request.urlopen(req, timeout=5)  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
            return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))


class AuthFailClosedProductionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _AuthFixture("production")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_production_login_rejected_503_no_token(self):
        status, payload = self.fx.login()
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"]["code"], "auth_unavailable")
        self.assertNotIn("token", payload)


class AuthDemoTokenDevTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _AuthFixture("development")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_development_login_keeps_demo_token(self):
        """development/simulation 保留演示行为（离线演示是设计内功能）。

        EDGE-027：演示 token 角色收敛为受限角色 operator（不再发放 admin），
        降低 auth 模块未就绪窗口内的越权面。
        """
        status, payload = self.fx.login()
        self.assertEqual(status, 200)
        self.assertIn("token", payload)
        self.assertEqual(payload["user"]["role"], "operator")


if __name__ == "__main__":
    unittest.main()
