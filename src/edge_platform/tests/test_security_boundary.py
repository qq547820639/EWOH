"""Task 36 安全边界渗透测试。

在 HTTP 边界层验证安全基线（spec「安全边界审查记录」）：
- 未认证访问受保护端点 → 401（/api/me、/api/auth/refresh）
- 越权导出：operator 角色携带有效 token 调用 export → 403
- SQL 注入：/api/query 注入 ' OR 1=1 → 不返回额外数据（白名单问答不执行原始 SQL）
- XSS 注入：/api/events/{id}/comment 注入 <script> → validate_input 拒绝或 JSON 响应安全
- 请求大小超限：POST body > 1MB → 400 body_too_large
- production 语义：匿名 export → 401（EDT-012，2026-08-17 审计整改补齐）

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_security_boundary -v
"""

import os
import sys
import unittest
from datetime import datetime, timedelta

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# EDT-014：共享 server fixture（本目录加入 path 后可导入）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _fixtures import _ServerFixture  # noqa: E402

from edge_platform.security import validate_input  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


# ---------- 1. 未认证访问受保护端点 ----------
class UnauthenticatedAccessTest(unittest.TestCase):
    """未认证访问受保护端点应返回 401。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture(prefix="ewoh_secbound_", telemetry_record_id="TS-SEC-001", event_id="EVT-SEC0001")

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
        cls.fx = _ServerFixture(prefix="ewoh_secbound_", telemetry_record_id="TS-SEC-001", event_id="EVT-SEC0001")

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
        status, _, body = self.fx.req(
            "/api/telemetry/export",
            method="POST",
            body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"},
            headers={"Authorization": "Bearer " + token},
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_operator_export_get_returns_403(self):
        """operator 登录后 GET /api/telemetry/export → 403 forbidden。"""
        token, _ = self.fx.login("operator", "operator123")
        self.assertIsNotNone(token)
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req(
            f"/api/telemetry/export?device_id=EXO-001&start={s}&end={e}", headers={"Authorization": "Bearer " + token}
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_admin_export_post_allowed(self):
        """admin 登录后 POST /api/telemetry/export → 200（admin 在默认导出名单内）。"""
        token, role = self.fx.login("admin", "admin123")
        self.assertIsNotNone(token)
        self.assertEqual(role, "admin")
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req(
            "/api/telemetry/export",
            method="POST",
            body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"},
            headers={"Authorization": "Bearer " + token},
        )
        self.assertEqual(status, 200)

    def test_export_without_token_still_works(self):
        """无 token（演示/离线模式）export 仍可用——不破坏现有无认证调用。"""
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req(
            "/api/telemetry/export",
            method="POST",
            body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"},
        )
        self.assertEqual(status, 200)

    def test_safety_officer_export_allowed(self):
        """safety_officer 登录后 export → 200（safety_officer 在默认导出名单内）。"""
        token, role = self.fx.login("safety_officer", "safety123")
        self.assertIsNotNone(token)
        self.assertEqual(role, "safety_officer")
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, _ = self.fx.req(
            "/api/telemetry/export",
            method="POST",
            body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"},
            headers={"Authorization": "Bearer " + token},
        )
        self.assertEqual(status, 200)


# ---------- 3. SQL 注入 ----------
class SqlInjectionTest(unittest.TestCase):
    """/api/query 注入 SQL 片段不应返回额外数据（白名单问答不执行原始 SQL）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture(prefix="ewoh_secbound_", telemetry_record_id="TS-SEC-001", event_id="EVT-SEC0001")

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
                status, _, body = self.fx.req("/api/query", method="POST", body={"question": payload})
                self.assertEqual(status, 200)
                # 白名单问答不执行 SQL：回答应拒绝或空问题提示，不应泄露数据
                self.assertNotIn("error", body, "不应返回服务端错误")
                # evidence 不应包含全表数据
                evidence = body.get("evidence", [])
                self.assertLessEqual(len(evidence), 50, "不应因注入返回大量数据")

    def test_normal_question_returns_real_evidence(self):
        """EDT-003 对照断言：正常问题返回非空 evidence——证明上方注入用例的
        "无额外数据"不是"端点本来就不返回数据"的恒真结果。"""
        status, _, body = self.fx.req("/api/query", method="POST", body={"question": "在线设备"})
        self.assertEqual(status, 200)
        self.assertFalse(body.get("refused"), "正常问题不应被拒答")
        evidence = body.get("evidence", [])
        self.assertGreater(len(evidence), 0, "在线设备问题应引用真实设备证据（对照断言）")
        device_ids = {e.get("device_id") for e in evidence}
        self.assertIn("EXO-001", device_ids, "种子设备 EXO-001 应出现在证据中")

    def test_normal_question_still_works(self):
        """正常问题仍能得到回答（回归）。"""
        status, _, body = self.fx.req("/api/query", method="POST", body={"question": "在线设备"})
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
        cls.fx = _ServerFixture(prefix="ewoh_secbound_", telemetry_record_id="TS-SEC-001", event_id="EVT-SEC0001")

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
            "/api/events/EVT-SEC0001/comment", method="POST", body={"comment": xss_payload, "author_id": "tester"}
        )
        self.assertEqual(status, 200)
        # 响应必须是 JSON（不是 HTML），浏览器不执行脚本
        self.assertIn("application/json", headers.get("Content-Type", ""))
        # handling 记录中 comment 应是原始字符串（未被解释执行）
        handling = body.get("handling") or {}
        self.assertEqual(handling.get("comment"), xss_payload)

    def test_xss_payload_preserved_as_string_in_storage(self):
        """XSS payload 存入 storage 后仍为纯字符串，读取后不变形。"""
        xss_payload = "<img onerror=alert(1) src=x>"
        self.fx.req(
            "/api/events/EVT-SEC0001/comment", method="POST", body={"comment": xss_payload, "author_id": "tester2"}
        )
        handlings = self.fx.storage.list_event_handlings("EVT-SEC0001")
        matched = [h for h in handlings if h.get("comment") == xss_payload]
        self.assertTrue(matched, "XSS payload 应以原始字符串存入 storage")

    def test_validate_input_rejects_xss(self):
        """validate_input 直接拒绝 XSS 模式。"""
        schema = {"comment": {"type": str}}
        for payload in ("<script>alert(1)</script>", "javascript:evil()", "<img onerror=alert(1)>"):
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
        cls.fx = _ServerFixture(prefix="ewoh_secbound_", telemetry_record_id="TS-SEC-001", event_id="EVT-SEC0001")

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_body_over_1mb_returns_400(self):
        """超过 1MB 的 POST body → 400 body_too_large。"""
        pad = "x" * (1024 * 1024 + 100)
        status, _, body = self.fx.req("/api/query", method="POST", body={"question": pad})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "body_too_large")

    def test_body_exactly_1mb_accepted(self):
        """略小于 1MB 的 body 应被接受（边界值）。"""
        # 构造一个略小于 1MB 的 JSON body
        pad = "x" * (1024 * 1024 - 200)
        status, _, _ = self.fx.req("/api/query", method="POST", body={"question": pad})
        # 不应返回 400 body_too_large
        self.assertNotEqual(status, 400)

    def test_raw_body_over_1mb_returns_400(self):
        """原始字节 body 超过 1MB → 400。"""
        big_bytes = b"x" * (1024 * 1024 + 100)
        status, _, raw = self.fx.raw("/api/query", method="POST", body_bytes=big_bytes)
        self.assertEqual(status, 400)


# ---------- 6. production 语义：导出必须认证（EDT-012） ----------
class ProductionExportAuthTest(unittest.TestCase):
    """EDT-012：production 模式下匿名导出必须 401（development 的宽松仅限离线演示）。

    development fixture（上方各类）覆盖演示语义；本类以真实 production 装配
    验证收紧语义：匿名 POST /api/telemetry/export → 401 unauthorized。
    """

    @classmethod
    def setUpClass(cls):
        cls._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = "production"
        from edge_platform.config import Settings

        Settings.reset()
        cls.fx = _ServerFixture(
            prefix="ewoh_secbound_prod_",
            telemetry_record_id="TS-SEC-P-001",
            event_id="EVT-SECP0001",
        )

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()
        os.environ.clear()
        os.environ.update(cls._old_env)
        from edge_platform.config import Settings

        Settings.reset()

    def test_production_anonymous_export_post_401(self):
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req(
            "/api/telemetry/export",
            method="POST",
            body={"device_id": "EXO-001", "start": s, "end": e, "format": "json"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_production_anonymous_export_get_401(self):
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        status, _, body = self.fx.req(
            f"/api/telemetry/export?device_id=EXO-001&start={s}&end={e}"
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")


if __name__ == "__main__":
    unittest.main()
