"""Task 9（P2）路由模块化 characterization 测试。

在 HTTP 边界验证 server.py 按 route domain 抽取到 edge_platform/routes/ 之后
契约保持不变：状态码、响应体形状、SSE 事件帧、统一错误信封、未命中回退行为
均与重构前逐字节一致。

覆盖原则：只补充既有测试未覆盖的缺口（SSE 帧、未知路径回退、新域端点），
不重复 test_api_endpoints / test_edge_security / test_monitoring 已断言的内容。

运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_server_routes_characterization -v
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# EDT-014：共享 server fixture（本目录加入 path 后可导入）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _fixtures import _ServerFixture  # noqa: E402

from edge_platform import server, stubs  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


class RouteContractCharacterizationTest(unittest.TestCase):
    """重构后关键端点契约：状态码 + 响应形状 + 错误信封 + 回退行为。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture(prefix="ewoh_routes_", telemetry_record_id="TS-RT-001", event_id="EVT-RT0001")

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    # ---- health 域 ----
    def test_get_status_shape(self):
        status, headers, body = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        self.assertIsNotNone(headers.get("X-Request-ID"))
        for key in ("offline", "now", "uptime_sec", "services", "source_labels"):
            self.assertIn(key, body)
        self.assertIn("gateway", body["services"])

    # ---- world 域 ----
    def test_get_devices_shape(self):
        status, headers, body = self.fx.req("/api/devices")
        self.assertEqual(status, 200)
        self.assertIsInstance(body["items"], list)
        self.assertIn("now", body)
        self.assertIn("offline_after_sec", body)

    def test_get_device_not_found_envelope(self):
        status, _, body = self.fx.req("/api/devices/NOT-EXIST")
        self.assertEqual(status, 404)
        self.assertEqual(set(body["error"].keys()), {"code", "message", "request_id"})
        self.assertEqual(body["error"]["code"], "not_found")

    # ---- telemetry 域 ----
    def test_get_telemetry_latest(self):
        status, _, body = self.fx.req("/api/telemetry")
        self.assertEqual(status, 200)
        self.assertEqual(body.get("mode"), "realtime")
        self.assertIn("device_id", body)

    def test_get_telemetry_series_replay(self):
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req(f"/api/telemetry/series?device_id=EXO-001&start={s}&end={e}")
        self.assertEqual(status, 200)
        self.assertEqual(body["mode"], "replay")
        self.assertIsInstance(body["items"], list)
        self.assertIn("inference", body)

    # ---- inference 域 ----
    def test_get_person_profile(self):
        status, _, body = self.fx.req("/api/person/profile?person_id=P-001")
        self.assertEqual(status, 200)
        self.assertEqual(body["person"]["person_id"], "P-001")
        self.assertIn("device", body)
        self.assertIn("skills", body)

    def test_get_demo_guide(self):
        status, _, body = self.fx.req("/api/demo/guide")
        self.assertEqual(status, 200)
        self.assertIsInstance(body["steps"], list)
        self.assertGreaterEqual(len(body["steps"]), 6)

    def test_post_query(self):
        status, _, body = self.fx.req("/api/query", method="POST", body={"question": "在线设备"})
        self.assertEqual(status, 200)
        self.assertIn("answer", body)

    def test_post_scenario_evaluate(self):
        status, _, body = self.fx.req(
            "/api/scenario/evaluate", method="POST", body={"structured": 3, "roi": 3}
        )
        self.assertEqual(status, 200)
        self.assertIsInstance(body, dict)

    def test_post_vision_understand_502(self):
        # 未配置 Ark API Key 时返回明确错误（不伪造描述），状态码 502
        status, _, body = self.fx.req("/api/vision/understand", method="POST", body={})
        self.assertEqual(status, 502)
        self.assertFalse(body.get("ok"))
        self.assertIn("error", body)

    # ---- scheduler 域 ----
    def test_get_tasks_assignments(self):
        status, _, body = self.fx.req("/api/tasks/assignments")
        self.assertEqual(status, 200)
        self.assertIsInstance(body["items"], list)

    def test_post_tasks_recommend(self):
        status, _, body = self.fx.req(
            "/api/tasks/recommend", method="POST", body={"required_skill": "搬运", "zone_id": "月台A"}
        )
        self.assertEqual(status, 200)
        self.assertIn("items", body)

    def test_post_tasks_confirm_success_200(self):
        """EDT-004：成功确认路径钉死 200（原 assertIn((200,409)) 双解接受）。

        前置：关闭种子事件 EVT-RT0001（P-001 的未处置 L2 事件会触发
        "高风险未解除"硬约束拦截——那是 409 拦截路径，在下方独立用例钉死）。
        """
        self.fx.storage.update_event_status(
            "EVT-RT0001", "closed", {"handled_by": "leader1", "action": "close"}
        )
        status, _, body = self.fx.req(
            "/api/tasks/confirm",
            method="POST",
            body={
                "task_id": "T-CONF-OK",
                "person_id": "P-001",
                "required_skill": "搬运",
                "zone_id": "月台A",
                "confirmer": "leader1",
            },
        )
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])
        self.assertEqual(body["assignment"]["person_id"], "P-001")
        self.assertEqual(body["assignment"]["status"], "confirmed")

    def test_post_tasks_confirm_hard_constraint_409(self):
        """EDT-004：硬约束拦截（高风险未解除）→ 钉死 409 + blocked_by 可解释。"""
        status, _, body = self.fx.req(
            "/api/tasks/confirm",
            method="POST",
            body={
                "task_id": "T-CONF-BLOCK",
                "person_id": "P-001",
                "required_skill": "搬运",
                "zone_id": "月台A",
                "confirmer": "leader1",
            },
        )
        self.assertEqual(status, 409, body)
        self.assertFalse(body["ok"])
        self.assertIn("blocked_by", body)
        self.assertTrue(any("高风险" in b for b in body["blocked_by"]))

    def test_post_tasks_confirm_missing_confirmer_409(self):
        """EDT-004：缺确认人被拒 → 钉死 409（禁止自动派工）。"""
        status, _, body = self.fx.req(
            "/api/tasks/confirm",
            method="POST",
            body={"task_id": "T-CONF-409", "required_skill": "搬运", "zone_id": "月台A"},
        )
        self.assertEqual(status, 409, body)
        self.assertFalse(body["ok"])
        self.assertIn("确认人", body["error"])

    def test_get_tasks_without_scheduler_503_envelope(self):
        # 未装配调度服务：业务层返回 503 not_ready，统一错误信封结构稳定
        status, _, body = self.fx.req("/api/tasks")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "not_ready")
        self.assertEqual(set(body["error"].keys()), {"code", "message", "request_id"})

    def test_patch_tasks_without_scheduler_503_envelope(self):
        status, _, body = self.fx.req("/api/tasks/T-X", method="PATCH", body={"status": "done"})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "not_ready")
        self.assertEqual(set(body["error"].keys()), {"code", "message", "request_id"})

    # ---- auth 域 ----
    def test_login_missing_creds_envelope_shape(self):
        # 空凭证 → 400 invalid_credentials；信封含 code/message/request_id
        status, _, body = self.fx.req("/api/auth/login", method="POST", body={"username": "", "password": ""})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_credentials")
        self.assertEqual(set(body["error"].keys()), {"code", "message", "request_id"})

    def test_me_without_token_401_envelope(self):
        status, _, body = self.fx.req("/api/me")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")
        self.assertIn("request_id", body["error"])

    # ---- 未命中回退（保持原契约） ----
    def test_post_unknown_path_fallback_404(self):
        # 原 do_POST 未命中分支：send_json({"error": "not found"}, 404)，非信封结构
        status, _, body = self.fx.req("/api/no-such-route", method="POST", body={})
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not found"})

    def test_patch_unknown_path_fallback_404(self):
        status, _, body = self.fx.req("/api/no-such-route", method="PATCH", body={})
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not found"})

    def test_get_unknown_api_path_static_fallback(self):
        # EDGE-025 整改后契约：未命中的 /api/* GET 返回 404 JSON（不再回退 SPA
        # index.html 200——与 POST 未命中 404 JSON 口径一致，消除 GET/POST 不对称）。
        status, headers, body = self.fx.raw("/api/no-such-route")
        self.assertEqual(status, 404)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertEqual(json.loads(body), {"error": "not found"})

    def test_post_unknown_body_too_large_precedence(self):
        # 1MB 上限判定先于路由分发（原 do_POST 先 read_json 再派发）
        pad = "x" * (1024 * 1024 + 100)
        status, _, body_bytes = self.fx.raw(
            "/api/no-such-route", method="POST", body_bytes=json.dumps({"q": pad}).encode()
        )
        self.assertEqual(status, 400)
        body = json.loads(body_bytes.decode("utf-8"))
        self.assertEqual(body["error"]["code"], "body_too_large")


class SseFramingTest(unittest.TestCase):
    """SSE /api/command-map/stream 帧契约（event_bus 未接线时：头 + retry 帧）。

    直接构造 Handler（复用 test_monitoring 的 fake-wfile 方式），避免长连接阻塞。
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sse_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        # 不注入 event_bus → 流在 retry 帧后立即返回
        self.ctx = server.Context(self.storage)
        self.handler_cls = server.make_handler(self.ctx)

    def tearDown(self):
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_handler(self, path):
        h = self.handler_cls.__new__(self.handler_cls)
        h.command = "GET"
        h.path = path
        h.headers = _FakeHeaders({"Content-Type": "text/plain"})
        h.rfile = io.BytesIO(b"")
        h._resp_status = None
        h._resp_headers = {}
        h._resp_body = io.BytesIO()

        class _WFile:
            def __init__(self, buf):
                self.buf = buf

            def write(self, data):
                self.buf.write(data)

            def flush(self):
                pass

        h.wfile = _WFile(h._resp_body)
        h.send_response = lambda status, message=None: setattr(h, "_resp_status", status)
        h.send_header = lambda k, v: h._resp_headers.__setitem__(k, v)
        h.end_headers = lambda: None
        h.log_message = lambda fmt, *args: None
        return h

    def test_sse_framing_contract(self):
        h = self._make_handler("/api/command-map/stream")
        h.do_GET()
        self.assertEqual(h._resp_status, 200)
        self.assertEqual(h._resp_headers.get("Content-Type"), "text/event-stream; charset=utf-8")
        self.assertEqual(h._resp_headers.get("Cache-Control"), "no-cache")
        self.assertEqual(h._resp_headers.get("X-Accel-Buffering"), "no")
        self.assertTrue(h._resp_body.getvalue().startswith(b"retry: 3000\n\n"))

    def test_sse_missing_event_bus_returns_without_error(self):
        # event_bus=None：写完头 + retry 帧后正常返回（不抛异常、不进入心跳循环）
        h = self._make_handler("/api/command-map/stream")
        h.do_GET()
        self.assertEqual(h._resp_body.getvalue(), b"retry: 3000\n\n")


class _FakeHeaders:
    """模拟 http.client.HTTPMessage 的最小 dict-like 接口。"""

    def __init__(self, d):
        self._d = {k.lower(): v for k, v in d.items()}

    def get(self, k, default=""):
        return self._d.get(k.lower(), default)


if __name__ == "__main__":
    unittest.main()
