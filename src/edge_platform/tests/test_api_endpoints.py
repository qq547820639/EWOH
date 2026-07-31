"""Task 16 API 完善端点测试。

覆盖新增的 12 个端点与 6 项横切关注点：
- 认证：/api/auth/login、/api/auth/refresh、/api/me
- 设备：/api/devices/{id}、/api/devices/{id}/health
- 遥测导出：POST /api/telemetry/export（json/csv，需审计）
- 事件：/api/events/{id}、/api/events/{id}/status、/api/events/{id}/comment
- 治理：/api/audit、/api/models、/api/rules
- 横切：X-Request-ID、统一错误响应、分页、请求体限制、审计日志

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_api_endpoints -v
"""

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
    """每个测试类共享一个 server 实例（随机端口），减少启停开销。"""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_api_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        # 插入一条遥测（带 battery/packet_loss）用于 health/export 测试
        now = datetime.now().astimezone()
        self.storage.insert_telemetry({
            "record_id": "TS-TEST-001", "device_id": "EXO-001",
            "timestamp": _iso(now), "sequence": 1, "source_type": "simulated",
            "telemetry": {"pitch_deg": 5.0, "load_score": 0.3, "battery_pct": 85,
                          "packet_loss_pct": 0.2},
            "quality": {"status": "good", "packet_loss_pct": 0.2}})
        # 插入一条结构化事件用于 event 端点测试
        self.storage.insert_event({
            "event_id": "EVT-TEST0001", "event_code": "LOAD_CONTINUOUS",
            "severity": "L2", "status": "open", "person_id": "P-001",
            "device_id": "EXO-001", "start_time": _iso(now),
            "trigger": {"type": "rule", "condition": "连续高负荷"},
            "evidence": {"window_before_sec": 30, "window_after_sec": 30},
            "source_type": "simulated"})
        # 注册一个模型与一条规则
        self.storage.insert_model_record("MODEL-A", "action_classifier", "0.1",
                                         model_card_uri="card://a")
        self.storage.insert_rule_record("RULE-LOAD", "v0.1", enabled=True,
                                        config_json={"threshold": 0.7}, severity="L2")
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(self.storage, bus, registry, rules)
        manager = stubs.AdapterManager(self.storage, bus)
        self.ctx = server.Context(self.storage, bus=bus, pipeline=pipeline,
                                  registry=registry, rules=rules, manager=manager)
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
            with urllib.request.urlopen(r, timeout=5) as resp:
                raw = resp.read().decode()
                return resp.status, resp.headers, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, e.headers, (json.loads(raw) if raw else {})

    def raw(self, path, method="GET", body_bytes=None, headers=None):
        """发起原始字节请求（用于测试超大 body），返回 (status, headers, body_bytes)。"""
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = urllib.request.Request(self.base + path, data=body_bytes, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()


class CrossCuttingTest(unittest.TestCase):
    """Task 16.6 横切关注点：请求 ID / 错误码 / 分页 / 请求体限制 / 审计。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_request_id_header_returned(self):
        """每个响应携带 X-Request-ID（uuid4 hex 前 8 位）。"""
        status, headers, _ = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        rid = headers.get("X-Request-ID")
        self.assertIsNotNone(rid)
        self.assertGreaterEqual(len(rid), 8)

    def test_request_id_echoes_inbound(self):
        """客户端传入 X-Request-ID 时原样回传。"""
        status, headers, _ = self.fx.req("/api/status", headers={"X-Request-ID": "abc12345"})
        self.assertEqual(headers.get("X-Request-ID"), "abc12345")

    def test_request_id_unique_per_request(self):
        """不同请求生成不同 X-Request-ID。"""
        _, h1, _ = self.fx.req("/api/status")
        _, h2, _ = self.fx.req("/api/status")
        self.assertNotEqual(h1.get("X-Request-ID"), h2.get("X-Request-ID"))

    def test_unified_error_format(self):
        """新端点错误响应为 {error: {code, message, request_id}}。"""
        status, _, body = self.fx.req("/api/devices/NOT-EXIST")
        self.assertEqual(status, 404)
        self.assertIn("error", body)
        self.assertIn("code", body["error"])
        self.assertIn("message", body["error"])
        self.assertIn("request_id", body["error"])

    def test_pagination_default_limit(self):
        """列表端点支持 ?limit=&offset=，默认 limit=100。"""
        status, _, body = self.fx.req("/api/audit")
        self.assertEqual(status, 200)
        self.assertEqual(body["limit"], 100)
        self.assertEqual(body["offset"], 0)

    def test_body_size_limit(self):
        """POST body 超过 1MB 返回 400。"""
        # 构造一个略超 1MB 的 JSON body
        pad = "x" * (1024 * 1024 + 100)
        status, _, body = self.fx.req("/api/query", method="POST",
                                      body={"question": pad})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "body_too_large")

    def test_post_auto_audit_logged(self):
        """POST 操作自动记审计日志（action/path/actor_id/request_id）。"""
        before = len(self.fx.storage.list_audit_logs())
        self.fx.req("/api/query", method="POST", body={"question": "数据来源"})
        after = len(self.fx.storage.list_audit_logs())
        self.assertGreater(after, before)
        # 最新一条审计日志应包含 POST 路径与 request_id
        log = self.fx.storage.list_audit_logs(limit=1)[0]
        self.assertIn("/api/query", log["action"])
        self.assertIsNotNone(log["request_id"])

    def test_actor_anonymous_without_token(self):
        """未认证时 actor_id 为 anonymous。"""
        self.fx.req("/api/query", method="POST", body={"question": "数据来源"})
        log = self.fx.storage.list_audit_logs(limit=1)[0]
        self.assertEqual(log["actor_id"], "anonymous")


class AuthEndpointTest(unittest.TestCase):
    """认证端点：/api/auth/login、/api/auth/refresh、/api/me。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_login_success(self):
        status, _, body = self.fx.req("/api/auth/login", method="POST",
                                      body={"username": "admin", "password": "admin123"})
        self.assertEqual(status, 200)
        self.assertTrue(body["token"])
        self.assertEqual(body["user"]["username"], "admin")

    def test_login_missing_credentials(self):
        status, _, body = self.fx.req("/api/auth/login", method="POST",
                                      body={"username": "", "password": ""})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_credentials")

    def test_login_wrong_password(self):
        status, _, body = self.fx.req("/api/auth/login", method="POST",
                                      body={"username": "admin", "password": "wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "invalid_credentials")

    def test_me_without_token(self):
        status, _, body = self.fx.req("/api/me")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_me_with_valid_token(self):
        _, _, login = self.fx.req("/api/auth/login", method="POST",
                                  body={"username": "admin", "password": "admin123"})
        token = login["token"]
        status, _, body = self.fx.req("/api/me", headers={"Authorization": "Bearer " + token})
        self.assertEqual(status, 200)
        self.assertEqual(body["user"]["user_id"], "U-ADMIN")

    def test_me_with_invalid_token(self):
        status, _, body = self.fx.req("/api/me", headers={"Authorization": "Bearer deadbeef"})
        self.assertEqual(status, 401)

    def test_refresh_rotates_token(self):
        _, _, login = self.fx.req("/api/auth/login", method="POST",
                                  body={"username": "operator", "password": "operator123"})
        old_token = login["token"]
        status, _, body = self.fx.req("/api/auth/refresh", method="POST",
                                      headers={"Authorization": "Bearer " + old_token})
        self.assertEqual(status, 200)
        new_token = body["token"]
        self.assertNotEqual(new_token, old_token)
        # 旧 token 失效
        s2, _, _ = self.fx.req("/api/me", headers={"Authorization": "Bearer " + old_token})
        self.assertEqual(s2, 401)
        # 新 token 有效
        s3, _, _ = self.fx.req("/api/me", headers={"Authorization": "Bearer " + new_token})
        self.assertEqual(s3, 200)

    def test_refresh_without_token(self):
        status, _, _ = self.fx.req("/api/auth/refresh", method="POST")
        self.assertEqual(status, 401)


class DeviceEndpointTest(unittest.TestCase):
    """设备端点：/api/devices/{id}、/api/devices/{id}/health。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_device_detail(self):
        status, _, body = self.fx.req("/api/devices/EXO-001")
        self.assertEqual(status, 200)
        self.assertEqual(body["device"]["device_id"], "EXO-001")
        self.assertIn("source_label", body["device"])

    def test_device_detail_not_found(self):
        status, _, body = self.fx.req("/api/devices/NOPE")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

    def test_device_health(self):
        status, _, body = self.fx.req("/api/devices/EXO-001/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["device_id"], "EXO-001")
        self.assertIn("online", body)
        self.assertIn("battery_pct", body)
        self.assertIn("packet_loss_pct", body)
        self.assertIn("last_seen", body)
        self.assertIn("fault", body)

    def test_device_health_not_found(self):
        status, _, body = self.fx.req("/api/devices/NOPE/health")
        self.assertEqual(status, 404)


class TelemetryExportPostTest(unittest.TestCase):
    """POST /api/telemetry/export — body 导出（json/csv，需审计）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def _window(self):
        now = datetime.now().astimezone()
        return _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))

    def test_export_json(self):
        s, e = self._window()
        status, _, body = self.fx.req("/api/telemetry/export", method="POST",
                                      body={"device_id": "EXO-001", "start": s, "end": e,
                                            "format": "json"})
        self.assertEqual(status, 200)
        self.assertEqual(body["export_type"], "raw_slice")
        self.assertEqual(body["device_id"], "EXO-001")
        self.assertIn("request_id", body)

    def test_export_csv(self):
        s, e = self._window()
        status, headers, raw = self.fx.raw(
            "/api/telemetry/export", method="POST",
            body_bytes=json.dumps({"device_id": "EXO-001", "start": s, "end": e,
                                   "format": "csv"}).encode())
        self.assertEqual(status, 200)
        self.assertIn("text/csv", headers.get("Content-Type", ""))
        text = raw.decode("utf-8-sig")
        self.assertIn("record_id", text)
        self.assertIn("EXO-001", text)

    def test_export_invalid_params(self):
        status, _, body = self.fx.req("/api/telemetry/export", method="POST",
                                      body={"device_id": "", "start": "", "end": ""})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_params")

    def test_export_invalid_format(self):
        s, e = self._window()
        status, _, body = self.fx.req("/api/telemetry/export", method="POST",
                                      body={"device_id": "EXO-001", "start": s, "end": e,
                                            "format": "xml"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_format")

    def test_export_audited(self):
        s, e = self._window()
        before = len(self.fx.storage.list_audit_logs(target_type="telemetry"))
        self.fx.req("/api/telemetry/export", method="POST",
                    body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"})
        after = len(self.fx.storage.list_audit_logs(target_type="telemetry"))
        self.assertGreater(after, before)


class EventEndpointTest(unittest.TestCase):
    """事件端点：/api/events/{id}、/api/events/{id}/status、/api/events/{id}/comment。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_event_detail(self):
        status, _, body = self.fx.req("/api/events/EVT-TEST0001")
        self.assertEqual(status, 200)
        self.assertEqual(body["event"]["event_id"], "EVT-TEST0001")
        self.assertIn("evidence_records", body)
        self.assertIn("handlings", body)

    def test_event_detail_not_found(self):
        status, _, body = self.fx.req("/api/events/EVT-NOPE")
        self.assertEqual(status, 404)

    def test_event_status_update(self):
        status, _, body = self.fx.req("/api/events/EVT-TEST0001/status", method="POST",
                                      body={"status": "confirmed", "handler_id": "leader1",
                                            "action": "confirm", "comment": "已核实"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["event"]["status"], "confirmed")
        # handling 记录已写入
        handlings = self.fx.storage.list_event_handlings("EVT-TEST0001")
        self.assertTrue(any(h["action"] == "confirm" for h in handlings))

    def test_event_status_invalid(self):
        status, _, body = self.fx.req("/api/events/EVT-TEST0001/status", method="POST",
                                      body={"status": "bogus"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_status")

    def test_event_status_not_found(self):
        status, _, body = self.fx.req("/api/events/EVT-NOPE/status", method="POST",
                                      body={"status": "closed"})
        self.assertEqual(status, 404)

    def test_event_comment(self):
        status, _, body = self.fx.req("/api/events/EVT-TEST0001/comment", method="POST",
                                      body={"comment": "需要现场复核", "author_id": "leader2"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIsNotNone(body["handling"])
        self.assertEqual(body["handling"]["action"], "comment")
        self.assertEqual(body["handling"]["comment"], "需要现场复核")

    def test_event_comment_empty(self):
        status, _, body = self.fx.req("/api/events/EVT-TEST0001/comment", method="POST",
                                      body={"comment": ""})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_params")


class RegistryEndpointTest(unittest.TestCase):
    """/api/audit、/api/models、/api/rules。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_models_list(self):
        status, _, body = self.fx.req("/api/models")
        self.assertEqual(status, 200)
        self.assertGreater(len(body["items"]), 0)
        self.assertEqual(body["items"][0]["model_id"], "MODEL-A")

    def test_rules_list(self):
        status, _, body = self.fx.req("/api/rules")
        self.assertEqual(status, 200)
        self.assertGreater(len(body["items"]), 0)
        self.assertEqual(body["items"][0]["rule_id"], "RULE-LOAD")

    def test_audit_list(self):
        # 先产生一条审计日志
        self.fx.req("/api/query", method="POST", body={"question": "数据来源"})
        status, _, body = self.fx.req("/api/audit")
        self.assertEqual(status, 200)
        self.assertGreater(len(body["items"]), 0)
        self.assertIn("limit", body)
        self.assertIn("offset", body)

    def test_audit_filter_by_action(self):
        self.fx.req("/api/query", method="POST", body={"question": "数据来源"})
        status, _, body = self.fx.req("/api/audit?action=POST+/api/query")
        self.assertEqual(status, 200)
        # 至少有一条 action 包含 /api/query
        actions = [item["action"] for item in body["items"]]
        self.assertTrue(any("/api/query" in a for a in actions))

    def test_audit_pagination(self):
        # 产生多条审计日志
        for _ in range(5):
            self.fx.req("/api/query", method="POST", body={"question": "数据来源"})
        status, _, p1 = self.fx.req("/api/audit?limit=2&offset=0")
        status2, _, p2 = self.fx.req("/api/audit?limit=2&offset=2")
        self.assertEqual(len(p1["items"]), 2)
        self.assertEqual(len(p2["items"]), 2)
        # 不同页不重叠
        ids1 = {i["audit_id"] for i in p1["items"]}
        ids2 = {i["audit_id"] for i in p2["items"]}
        self.assertEqual(len(ids1 & ids2), 0)


class ExistingEndpointsRegressionTest(unittest.TestCase):
    """现有端点不回归：X-Request-ID 头部存在、原有响应结构不变。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_status_still_works(self):
        status, headers, body = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        self.assertIn("services", body)
        self.assertIsNotNone(headers.get("X-Request-ID"))

    def test_devices_list_still_works(self):
        status, _, body = self.fx.req("/api/devices")
        self.assertEqual(status, 200)
        self.assertIn("items", body)

    def test_events_list_still_works(self):
        status, _, body = self.fx.req("/api/events")
        self.assertEqual(status, 200)
        self.assertIn("items", body)

    def test_legacy_event_detail_still_works(self):
        status, _, body = self.fx.req("/api/event?id=EVT-TEST0001")
        self.assertEqual(status, 200)
        self.assertEqual(body["event"]["event_id"], "EVT-TEST0001")

    def test_legacy_event_status_post_still_works(self):
        status, _, body = self.fx.req("/api/event/status", method="POST",
                                      body={"event_id": "EVT-TEST0001", "status": "open",
                                            "handled_by": "tester"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_legacy_reset_still_works(self):
        status, _, body = self.fx.req("/api/reset", method="POST", body={})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])


if __name__ == "__main__":
    unittest.main()
