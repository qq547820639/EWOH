"""R2-EDM-02 修复回归：ark_vision SSRF 固定 IP 直连 + 手动逐跳重定向复检。

不依赖外网：DNS 解析与 HTTP 连接层均通过 mock 隔离，仅验证安全逻辑本身
（公网校验 fail-closed、重定向逐跳复检、跳数上限）。
"""

import sys
import unittest
from email.message import Message
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.perception import ark_vision  # noqa: E402


class ResolvePublicIpTest(unittest.TestCase):
    """R2-EDM-02：校验与连接共用一次解析，内网/元数据地址 fail-closed。"""

    def test_literal_internal_ips_rejected(self):
        for host in ("127.0.0.1", "10.0.0.8", "192.168.1.100", "169.254.169.254"):
            ip, reason = ark_vision.resolve_public_ip(host)
            self.assertIsNone(ip, f"{host} 应被拒绝")
            self.assertEqual(reason, "internal_address")

    def test_literal_public_ip_pinned(self):
        ip, reason = ark_vision.resolve_public_ip("93.184.216.34")
        self.assertEqual(ip, "93.184.216.34")
        self.assertIsNone(reason)

    def test_validate_outbound_url_rejects_non_http_scheme(self):
        ok, reason = ark_vision.validate_outbound_url("file:///etc/passwd")
        self.assertFalse(ok)
        self.assertEqual(reason, "invalid_scheme")


class PinnedRequestGuardTest(unittest.TestCase):
    """R2-EDM-02：_pinned_request 在连接前完成校验，拒绝即抛 _OutboundBlocked。"""

    def test_rejects_non_http_scheme_before_any_io(self):
        with self.assertRaises(ark_vision._OutboundBlocked) as ctx:
            ark_vision._pinned_request("file:///etc/passwd", "GET", {}, None)
        self.assertEqual(ctx.exception.reason, "invalid_scheme")

    def test_rejects_internal_host_fail_closed(self):
        with mock.patch.object(
            ark_vision, "resolve_public_ip", return_value=(None, "internal_address")
        ):
            with self.assertRaises(ark_vision._OutboundBlocked) as ctx:
                ark_vision._pinned_request("http://internal.host/x", "GET", {}, None)
        self.assertEqual(ctx.exception.reason, "internal_address")


class DescribeImageRedirectGuardTest(unittest.TestCase):
    """R2-EDM-02：重定向逐跳复检 + 跳数上限，指向内网即整体拒绝。"""

    @staticmethod
    def _headers(location=None):
        msg = Message()
        if location:
            msg["Location"] = location
        return msg

    def _run_describe(self, pinned_side_effect, resolve_map=None):
        mapping = {"public.example": ("93.184.216.34", None)}
        if resolve_map:
            mapping.update(resolve_map)
        with mock.patch.object(
            ark_vision, "resolve_public_ip", side_effect=lambda h: mapping.get(h, (None, "dns_resolution_failed"))
        ), mock.patch.object(
            ark_vision, "_pinned_request", side_effect=pinned_side_effect
        ):
            return ark_vision.describe_image(
                api_key="test-key",
                base_url="http://public.example/api/v3",
            )

    def test_redirect_to_internal_host_rejected(self):
        calls = []

        def fake_pinned(url, method, headers, body, timeout=60):
            calls.append(url)
            if "public.example" in url:
                return 302, self._headers("http://internal.host/steal"), b""
            # 模拟真实 _pinned_request：对内网 host 的校验 fail-closed
            raise ark_vision._OutboundBlocked("internal_address")

        result = self._run_describe(fake_pinned, {"internal.host": (None, "internal_address")})
        self.assertFalse(result["ok"])
        self.assertIn("internal_address", result["error"])
        # 第二跳确实被送入复检且被拒，之后不再发起任何请求
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1], "http://internal.host/steal")

    def test_redirect_chain_exceeds_max_rejected(self):
        def fake_pinned(url, method, headers, body, timeout=60):
            return 302, self._headers(f"{url}?hop=1"), b""

        result = self._run_describe(fake_pinned)
        self.assertFalse(result["ok"])
        self.assertIn("重定向超过", result["error"])

    def test_no_redirect_success_path_parses_content(self):
        payload = (
            b'{"choices":[{"message":{"content":"ok"}}]}'
        )

        def fake_pinned(url, method, headers, body, timeout=60):
            return 200, self._headers(), payload

        result = self._run_describe(fake_pinned)
        self.assertTrue(result["ok"])
        self.assertEqual(result["answer"], "ok")


if __name__ == "__main__":
    unittest.main()
