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
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


class _ServerFixture:
    """真实 HTTP server（随机端口），与 test_api_endpoints 相同的装配方式。"""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_routes_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        now = datetime.now().astimezone()
        self.storage.insert_telemetry(
            {
                "record_id": "TS-RT-001",
                "device_id": "EXO-001",
                "timestamp": _iso(now),
                "sequence": 1,
                "source_type": "simulated",
                "telemetry": {"pitch_deg": 5.0, "load_score": 0.3, "battery_pct": 85},
                "quality": {"status": "good"},
            }
        )
        self.storage.insert_event(
            {
                "event_id": "EVT-RT0001",
                "event_code": "LOAD_CONTINUOUS",
                "severity": "L2",
                "status": "open",
                "person_id": "P-001",
                "device_id": "EXO-001",
                "start_time": _iso(now),
                "trigger": {"type": "rule", "condition": "连续高负荷"},
                "evidence": {"window_before_sec": 30, "window_after_sec": 30},
                "source_type": "simulated",
            }
        )
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(self.storage, bus, registry, rules)
        manager = stubs.AdapterManager(self.storage, bus)
        self.ctx = server.Context(
            self.storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager
        )
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, path, method="GET", body=None, headers=None):
        """发起请求，返回 (status, headers, body_dict)。"""
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                raw = resp.read().decode()
                return resp.status, resp.headers, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, e.headers, (json.loads(raw) if raw else {})

    def raw(self, path, method="GET", body_bytes=None, headers=None):
        """发起原始字节请求，返回 (status, headers, body_bytes)。"""
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = urllib.request.Request(self.base + path, data=body_bytes, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()


class RouteContractCharacterizationTest(unittest.TestCase):
    """重构后关键端点契约：状态码 + 响应形状 + 错误信封 + 回退行为。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

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

    def test_post_tasks_confirm_envelope(self):
        status, _, body = self.fx.req(
            "/api/tasks/confirm",
            method="POST",
            body={"task_id": "T-CONF", "required_skill": "搬运", "zone_id": "月台A"},
        )
        self.assertIn(status, (200, 409))
        self.assertIn("ok", body)

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
        # 原 do_GET 未命中分支：super().do_GET() 静态文件回退（/api/* → index.html，200）
        status, headers, _ = self.fx.raw("/api/no-such-route")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))

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
