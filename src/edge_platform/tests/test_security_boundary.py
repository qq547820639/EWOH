"""Task 36 安全边界渗透测试。

在 HTTP 边界层验证安全基线（spec「安全边界审查记录」）：
- 未认证访问受保护端点 → 401（/api/me、/api/auth/refresh）
- 越权导出：operator 角色携带有效 token 调用 export → 403
- SQL 注入：/api/query 注入 ' OR 1=1 → 不返回额外数据（白名单问答不执行原始 SQL）
- XSS 注入：/api/events/{id}/comment 注入 <script> → validate_input 拒绝或 JSON 响应安全
- 请求大小超限：POST body > 1MB → 400 body_too_large

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_security_boundary -v
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
from edge_platform.security import validate_input  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


class _ServerFixture:
    """每个测试类共享一个 server 实例（随机端口）。"""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_secbound_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        # 插入一条遥测供 export 测试
        now = datetime.now().astimezone()
        self.storage.insert_telemetry({
            "record_id": "TS-SEC-001", "device_id": "EXO-001",
            "timestamp": _iso(now), "sequence": 1, "source_type": "simulated",
            "telemetry": {"pitch_deg": 5.0, "load_score": 0.3, "battery_pct": 85},
            "quality": {"status": "good"}})
        # 插入一条事件供 comment XSS 测试
        self.storage.insert_event({
            "event_id": "EVT-SEC0001", "event_code": "LOAD_CONTINUOUS",
            "severity": "L2", "status": "open", "person_id": "P-001",
            "device_id": "EXO-001", "start_time": _iso(now),
            "trigger": {"type": "rule", "condition": "连续高负荷"},
            "evidence": {"window_before_sec": 30, "window_after_sec": 30},
            "source_type": "simulated"})
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

    def login(self, username, password):
        """登录获取 Bearer token；返回 (token, role) 或 (None, None)。"""
        status, _, body = self.req("/api/auth/login", method="POST",
                                   body={"username": username, "password": password})
        if status == 200:
            return body["token"], body["user"].get("role")
        return None, None


# ---------- 1. 未认证访问受保护端点 ----------
class UnauthenticatedAccessTest(unittest.TestCase):
    """未认证访问受保护端点应返回 401。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_me_without_token_returns_401(self):
        """GET /api/me 无 Bearer token → 401 unauthorized。"""
        status, _, body = self.fx.req("/api/me")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_refresh_without_token_returns_401(self):
        """POST /api/auth/refresh 无 Bearer token → 401 unauthorized。"""
        status, _, body = self.fx.req("/api/auth/refresh", method="POST")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_me_with_invalid_token_returns_401(self):
        """GET /api/me 携带无效 token → 401。"""
        status, _, _ = self.fx.req("/api/me", headers={"Authorization": "Bearer deadbeef"})
        self.assertEqual(status, 401)

    def test_me_with_malformed_auth_header_returns_401(self):
        """GET /api/me 携带非 Bearer 格式的 Authorization → 401。"""
        status, _, _ = self.fx.req("/api/me", headers={"Authorization": "Basic abc123"})
        self.assertEqual(status, 401)


# ---------- 2. 越权导出 ----------
class PrivilegeEscalationExportTest(unittest.TestCase):
    """operator 角色携带有效 token 调用 export → 403；admin 角色允许。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_operator_export_post_returns_403(self):
        """operator 登录后 POST /api/telemetry/export → 403 forbidden。"""
        token, role = self.fx.login("operator", "operator123")
        self.assertIsNotNone(token)
        self.assertEqual(role, "operator")
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req("/api/telemetry/export", method="POST",
                                      body={"device_id": "EXO-001", "start": s, "end": e,
                                            "format": "json"},
                                      headers={"Authorization": "Bearer " + token})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_operator_export_get_returns_403(self):
        """operator 登录后 GET /api/telemetry/export → 403 forbidden。"""
        token, _ = self.fx.login("operator", "operator123")
        self.assertIsNotNone(token)
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req(
            f"/api/telemetry/export?device_id=EXO-001&start={s}&end={e}",
            headers={"Authorization": "Bearer " + token})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_admin_export_post_allowed(self):
        """admin 登录后 POST /api/telemetry/export → 200（admin 在默认导出名单内）。"""
        token, role = self.fx.login("admin", "admin123")
        self.assertIsNotNone(token)
        self.assertEqual(role, "admin")
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req("/api/telemetry/export", method="POST",
                                   body={"device_id": "EXO-001", "start": s, "end": e,
                                         "format": "json"},
                                   headers={"Authorization": "Bearer " + token})
        self.assertEqual(status, 200)

    def test_export_without_token_still_works(self):
        """无 token（演示/离线模式）export 仍可用——不破坏现有无认证调用。"""
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req("/api/telemetry/export", method="POST",
                                   body={"device_id": "EXO-001", "start": s, "end": e,
                                         "format": "json"})
        self.assertEqual(status, 200)

    def test_safety_officer_export_allowed(self):
        """safety_officer 登录后 export → 200（safety_officer 在默认导出名单内）。"""
        token, role = self.fx.login("safety_officer", "safety123")
        self.assertIsNotNone(token)
        self.assertEqual(role, "safety_officer")
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req("/api/telemetry/export", method="POST",
                                   body={"device_id": "EXO-001", "start": s, "end": e,
                                         "format": "json"},
                                   headers={"Authorization": "Bearer " + token})
        self.assertEqual(status, 200)


# ---------- 3. SQL 注入 ----------
class SqlInjectionTest(unittest.TestCase):
    """/api/query 注入 SQL 片段不应返回额外数据（白名单问答不执行原始 SQL）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_sql_injection_in_query_returns_no_extra_data(self):
        """注入 ' OR 1=1 不应返回额外数据或泄露内部信息。"""
        payloads = [
            "' OR 1=1--",
            "1; DROP TABLE telemetry--",
            "1' UNION SELECT * FROM device--",
            "admin' OR '1'='1",
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                status, _, body = self.fx.req("/api/query", method="POST",
                                              body={"question": payload})
                self.assertEqual(status, 200)
                # 白名单问答不执行 SQL：回答应拒绝或空问题提示，不应泄露数据
                self.assertNotIn("error", body, "不应返回服务端错误")
                # evidence 不应包含全表数据
                evidence = body.get("evidence", [])
                self.assertLessEqual(len(evidence), 50,
                                     "不应因注入返回大量数据")

    def test_normal_question_still_works(self):
        """正常问题仍能得到回答（回归）。"""
        status, _, body = self.fx.req("/api/query", method="POST",
                                      body={"question": "在线设备"})
        self.assertEqual(status, 200)
        self.assertIn("answer", body)

    def test_validate_input_rejects_sql_injection(self):
        """validate_input 直接拒绝 SQL 注入模式。"""
        schema = {"q": {"type": str}}
        ok, errs = validate_input({"q": "1' OR 1=1--"}, schema)
        self.assertFalse(ok)
        self.assertTrue(any("注入" in e for e in errs))


# ---------- 4. XSS 注入 ----------
class XssInjectionTest(unittest.TestCase):
    """comment 注入 <script> 应被拒绝或安全返回（JSON 响应不执行脚本）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_xss_in_comment_accepted_but_json_safe(self):
        """comment 中的 <script> 以纯字符串存入，JSON 响应 Content-Type 安全。

        平台 API 响应 Content-Type 为 application/json，浏览器不执行内嵌脚本；
        comment 作为纯字符串存储与返回，不会被解释为 HTML。
        """
        xss_payload = "<script>alert('xss')</script>"
        status, headers, body = self.fx.req(
            "/api/events/EVT-SEC0001/comment", method="POST",
            body={"comment": xss_payload, "author_id": "tester"})
        self.assertEqual(status, 200)
        # 响应必须是 JSON（不是 HTML），浏览器不执行脚本
        self.assertIn("application/json", headers.get("Content-Type", ""))
        # handling 记录中 comment 应是原始字符串（未被解释执行）
        handling = body.get("handling") or {}
        self.assertEqual(handling.get("comment"), xss_payload)

    def test_xss_payload_preserved_as_string_in_storage(self):
        """XSS payload 存入 storage 后仍为纯字符串，读取后不变形。"""
        xss_payload = "<img onerror=alert(1) src=x>"
        self.fx.req("/api/events/EVT-SEC0001/comment", method="POST",
                    body={"comment": xss_payload, "author_id": "tester2"})
        handlings = self.fx.storage.list_event_handlings("EVT-SEC0001")
        matched = [h for h in handlings if h.get("comment") == xss_payload]
        self.assertTrue(matched, "XSS payload 应以原始字符串存入 storage")

    def test_validate_input_rejects_xss(self):
        """validate_input 直接拒绝 XSS 模式。"""
        schema = {"comment": {"type": str}}
        for payload in ("<script>alert(1)</script>", "javascript:evil()",
                        "<img onerror=alert(1)>"):
            ok, errs = validate_input({"comment": payload}, schema)
            self.assertFalse(ok, f"应拒绝: {payload}")

    def test_security_headers_prevent_xss(self):
        """所有响应携带 X-Content-Type-Options: nosniff，阻止 MIME 嗅探。"""
        status, headers, _ = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")


# ---------- 5. 请求大小超限 ----------
class BodySizeLimitTest(unittest.TestCase):
    """POST body 超过 1MB → 400 body_too_large。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_body_over_1mb_returns_400(self):
        """超过 1MB 的 POST body → 400 body_too_large。"""
        pad = "x" * (1024 * 1024 + 100)
        status, _, body = self.fx.req("/api/query", method="POST",
                                      body={"question": pad})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "body_too_large")

    def test_body_exactly_1mb_accepted(self):
        """略小于 1MB 的 body 应被接受（边界值）。"""
        # 构造一个略小于 1MB 的 JSON body
        pad = "x" * (1024 * 1024 - 200)
        status, _, _ = self.fx.req("/api/query", method="POST",
                                   body={"question": pad})
        # 不应返回 400 body_too_large
        self.assertNotEqual(status, 400)

    def test_raw_body_over_1mb_returns_400(self):
        """原始字节 body 超过 1MB → 400。"""
        big_bytes = b"x" * (1024 * 1024 + 100)
        status, _, raw = self.fx.raw("/api/query", method="POST", body_bytes=big_bytes)
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
