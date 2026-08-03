"""Task 30 安全模块测试：SecurityHeaders / rate_limiter / validate_input。

覆盖：
- SecurityHeaders：apply 注入三项头、wrap 包装 handler 类后 end_headers 自动注入；
- rate_limiter：未超限放行、超限返回 429、不同 IP 独立计数、reset 清除；
- validate_input：必填/类型/长度/注入检测、空 schema 与非 dict 输入；
- 集成：build_server 启动后 /api/security/policy 返回非敏感字段，
  所有响应携带安全头。

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_security -v
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
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs  # noqa: E402
from edge_platform.security import (  # noqa: E402
    SecurityHeaders,
    rate_limiter,
    validate_input,
)


# ---------- SecurityHeaders ----------
class _FakeHandler:
    """最小 handler 桩：记录 send_header 调用。"""

    def __init__(self):
        self.headers = []

    def send_header(self, name, value):
        self.headers.append((name, value))


class SecurityHeadersTest(unittest.TestCase):
    def test_apply_injects_three_headers(self):
        h = _FakeHandler()
        SecurityHeaders.apply(h)
        names = [n for n, _ in h.headers]
        self.assertIn("X-Content-Type-Options", names)
        self.assertIn("X-Frame-Options", names)
        self.assertIn("Cache-Control", names)
        d = dict(h.headers)
        self.assertEqual(d["X-Content-Type-Options"], "nosniff")
        self.assertEqual(d["X-Frame-Options"], "DENY")
        self.assertEqual(d["Cache-Control"], "no-store")

    def test_wrap_overrides_end_headers(self):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

        original = H.end_headers
        SecurityHeaders.wrap(H)
        self.assertIsNot(H.end_headers, original)

    def test_headers_constant_immutable_shape(self):
        # 三项固定头存在，不缺不多
        self.assertEqual(
            set(SecurityHeaders.HEADERS.keys()), {"X-Content-Type-Options", "X-Frame-Options", "Cache-Control"}
        )


# ---------- rate_limiter ----------
def _make_counting_handler():
    """每次调用返回一个全新的计数 handler 类。

    rate_limiter 装饰器会就地包装 handler 类的 do_GET/do_POST，
    复用同一个类会导致多测试间包装层叠加，因此每个测试需独立类。
    """

    class _CountingHandler(BaseHTTPRequestHandler):
        counter = 0

        def log_message(self, *a):
            pass

        def do_GET(self):
            type(self).counter += 1
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return _CountingHandler


class RateLimiterTest(unittest.TestCase):
    def test_under_limit_passes(self):
        handler_cls = _make_counting_handler()
        cls = rate_limiter(max_per_minute=5)(handler_cls)
        httpd = HTTPServer(("127.0.0.1", 0), cls)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}/"
            for _ in range(3):
                with urllib.request.urlopen(base, timeout=3) as r:  # nosec B310 - local test HTTP client
                    self.assertEqual(r.status, 200)
            self.assertEqual(handler_cls.counter, 3)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_over_limit_returns_429(self):
        handler_cls = _make_counting_handler()
        cls = rate_limiter(max_per_minute=2)(handler_cls)
        httpd = HTTPServer(("127.0.0.1", 0), cls)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}/"
            # 前两次 200
            for _ in range(2):
                with urllib.request.urlopen(base, timeout=3) as r:  # nosec B310 - local test HTTP client
                    self.assertEqual(r.status, 200)
            # 第三次 429
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(base, timeout=3)  # nosec B310 - local test HTTP client
            self.assertEqual(ctx.exception.code, 429)
            self.assertEqual(ctx.exception.headers.get("Retry-After"), "60")
            # handler 只被调用 2 次（第三次被限流拦截）
            self.assertEqual(handler_cls.counter, 2)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_different_ips_independent(self):
        # 不同 IP 独立计数（用 X-Forwarded-For 无法测，这里直接测 _RateLimiter）
        from edge_platform.security import _RateLimiter

        rl = _RateLimiter(max_per_minute=2)
        self.assertTrue(rl.check("1.1.1.1"))
        self.assertTrue(rl.check("1.1.1.1"))
        self.assertFalse(rl.check("1.1.1.1"))
        # 不同 IP 仍可用
        self.assertTrue(rl.check("2.2.2.2"))
        self.assertTrue(rl.check("2.2.2.2"))
        self.assertFalse(rl.check("2.2.2.2"))

    def test_reset_clears_bucket(self):
        from edge_platform.security import _RateLimiter

        rl = _RateLimiter(max_per_minute=1)
        self.assertTrue(rl.check("1.1.1.1"))
        self.assertFalse(rl.check("1.1.1.1"))
        rl.reset("1.1.1.1")
        self.assertTrue(rl.check("1.1.1.1"))
        # 全部清除
        rl.check("2.2.2.2")
        rl.reset()
        self.assertTrue(rl.check("2.2.2.2"))

    def test_exposes_rate_limiter_instance(self):
        handler_cls = _make_counting_handler()
        cls = rate_limiter(max_per_minute=10)(handler_cls)
        self.assertTrue(hasattr(cls, "_rate_limiter"))
        self.assertEqual(cls._rate_limiter.max, 10)


# ---------- validate_input ----------
class ValidateInputTest(unittest.TestCase):
    def test_required_missing(self):
        schema = {"name": {"required": True}}
        ok, errs = validate_input({}, schema)
        self.assertFalse(ok)
        self.assertTrue(any("name" in e for e in errs))

    def test_required_empty_string(self):
        schema = {"name": {"required": True}}
        ok, errs = validate_input({"name": ""}, schema)
        self.assertFalse(ok)

    def test_type_check(self):
        schema = {"age": {"type": int}}
        ok, errs = validate_input({"age": "abc"}, schema)
        self.assertFalse(ok)
        self.assertTrue(any("类型" in e for e in errs))
        ok2, _ = validate_input({"age": 18}, schema)
        self.assertTrue(ok2)

    def test_bool_rejected_for_int(self):
        # bool 是 int 子类，应被拒绝
        schema = {"flag": {"type": int}}
        ok, _ = validate_input({"flag": True}, schema)
        self.assertFalse(ok)

    def test_max_length(self):
        schema = {"note": {"type": str, "max_length": 5}}
        ok, _ = validate_input({"note": "12345"}, schema)
        self.assertTrue(ok)
        ok2, errs = validate_input({"note": "123456"}, schema)
        self.assertFalse(ok2)
        self.assertTrue(any("长度" in e for e in errs))

    def test_injection_sql(self):
        schema = {"q": {"type": str}}
        for payload in ("1; DROP TABLE users--", "1' OR 1=1--", "union select * from x", "delete from t where 1=1"):
            ok, errs = validate_input({"q": payload}, schema)
            self.assertFalse(ok, f"应拒绝: {payload}")
            self.assertTrue(any("注入" in e for e in errs))

    def test_injection_xss(self):
        schema = {"q": {"type": str}}
        for payload in ("<script>alert(1)</script>", "javascript:evil()", "<img onerror=alert(1)>"):
            ok, errs = validate_input({"q": payload}, schema)
            self.assertFalse(ok, f"应拒绝: {payload}")

    def test_normal_text_passes(self):
        schema = {"note": {"type": str, "max_length": 100, "required": True}}
        ok, errs = validate_input({"note": "正常文本 hello world 123"}, schema)
        self.assertTrue(ok)
        self.assertEqual(errs, [])

    def test_non_dict_input(self):
        ok, errs = validate_input("not a dict", {})
        self.assertFalse(ok)
        self.assertTrue(any("字典" in e for e in errs))

    def test_empty_schema_passes(self):
        ok, _ = validate_input({"anything": 1}, {})
        self.assertTrue(ok)

    def test_optional_missing_passes(self):
        schema = {"name": {"type": str, "required": False}}
        ok, _ = validate_input({}, schema)
        self.assertTrue(ok)


# ---------- 集成：/api/security/policy + 安全头 ----------
class _ServerFixture:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sec_")
        self.db_path = os.path.join(self.tmp, "test.db")
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(os.path.join(self.tmp, "models"))
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

    def req(self, path):
        r = urllib.request.Request(self.base + path, method="GET")
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                raw = resp.read().decode()
                return resp.status, resp.headers, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, e.headers, (json.loads(raw) if raw else {})


class SecurityPolicyEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_policy_returns_non_sensitive_fields(self):
        status, _, body = self.fx.req("/api/security/policy")
        self.assertEqual(status, 200)
        self.assertIn("tls_enabled", body)
        self.assertIn("session_timeout_sec", body)
        self.assertIn("login_fail_lock", body)
        # 敏感字段不返回值，仅在 redacted 列表中声明
        for secret in ("tls_cert", "tls_key", "jwt_secret", "oidc_client_id"):
            self.assertNotIn(secret, body)
        self.assertIn("redacted", body)
        for secret in ("tls_cert", "tls_key", "jwt_secret", "oidc_client_id"):
            self.assertIn(secret, body["redacted"])

    def test_policy_tls_disabled_by_default(self):
        # 默认配置（无环境变量）→ tls_enabled False
        status, _, body = self.fx.req("/api/security/policy")
        self.assertEqual(status, 200)
        self.assertFalse(body["tls_enabled"])

    def test_security_headers_on_api_response(self):
        # build_server 注入 SecurityHeaders，所有响应携带三项安全头
        status, headers, _ = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_security_headers_on_policy_endpoint(self):
        status, headers, _ = self.fx.req("/api/security/policy")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")


if __name__ == "__main__":
    unittest.main()
