"""ark_vision 重定向凭据保护测试（2026-08-19 审计 P1 回归）。

覆盖：跨 host 重定向剥离 Authorization 头（Bearer api_key 不随 302 转发给
重定向目标——CDN/预签名域名或被劫持 host 不应收到 API Key）；同 host
重定向保留 Authorization（登录跳转/网关内部跳转不破坏认证）。
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.perception import ark_vision


def _ok_body(text="ok"):
    return json.dumps(
        {"choices": [{"message": {"content": text}}]}
    ).encode("utf-8")


class RedirectAuthorizationTest(unittest.TestCase):
    def _run(self, redirect_location):
        """describe_image 走一跳重定向：记录每跳实际发出的 headers。"""
        sent = []

        def fake_pinned_request(url, method, headers, body, timeout=60):
            sent.append({"url": url, "headers": dict(headers)})
            if len(sent) == 1:
                return 302, {"Location": redirect_location}, b""
            return 200, {}, _ok_body()

        with mock.patch.object(ark_vision, "validate_outbound_url", return_value=(True, None)), \
             mock.patch.object(ark_vision, "_pinned_request", side_effect=fake_pinned_request):
            result = ark_vision.describe_image(
                image_url="",
                api_key="SECRET-KEY",
                base_url="https://ark.example.com/api/v3",
                model="test-model",
            )
        return result, sent

    def test_cross_host_redirect_strips_authorization(self):
        """P1 回归：跨 host 302 的第二跳请求头中不得再含 Authorization。"""
        result, sent = self._run("https://cdn.example.com/v3/chat/completions")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(len(sent), 2)
        # 第一跳（原 host）：携带凭据
        self.assertEqual(sent[0]["headers"].get("Authorization"), "Bearer SECRET-KEY")
        # 第二跳（跨 host）：凭据已剥离
        self.assertNotIn("Authorization", sent[1]["headers"])

    def test_same_host_redirect_keeps_authorization(self):
        """同 host 重定向（网关内部跳转）保留认证——不破坏合法跳转。"""
        result, sent = self._run("https://ark.example.com/api/v3/v2/chat/completions")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[1]["headers"].get("Authorization"), "Bearer SECRET-KEY")


if __name__ == "__main__":
    unittest.main()
