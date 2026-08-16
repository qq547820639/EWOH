#!/usr/bin/env python3
"""边缘安灯路由测试（ADR-040 / §6 Phase 6：andon-loop 边缘上行）。

覆盖：开灯规范身份 fail-closed / 标题必填 / 严重度词表封闭校验 /
slaSeconds 校验 / AndonRaised Catalog 信封发射（STREAM_EVENTS 主题 +
canonical payload）/ registry POST 分发（含 Round 54 exo POST 分发缺口修复）。
直接调用路由 handler + registry.dispatch（fake ctx/handler），不发真实 HTTP。

纯 Python 标准库 unittest。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server  # noqa: F401 （先加载 server，避免 auth↔registry 循环导入）
from edge_platform.routes.andon import api_andon_raise  # noqa: E402
from edge_platform.routes import ReqMeta  # noqa: E402
from edge_platform.routes.registry import dispatch  # noqa: E402


class _FakeBus:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, payload))


class _FakeHandler:
    def __init__(self):
        self.responses = []

    def send_json(self, payload, status=200):
        self.responses.append((status, payload))
        return payload

    def _new_error(self, code, message, status):
        self.responses.append((status, {"error": code, "message": message}))
        return {"error": code, "message": message}


class _FakeCtx:
    def __init__(self, bus):
        self.bus = bus


def _req(path, body):
    parts = [p for p in path.split("/") if p]
    return ReqMeta(
        method="POST", path=path, path_parts=parts,
        query={}, body=json.dumps(body), headers={}, client=("127.0.0.1", 12345),
    )


class AndonRaiseRouteTest(unittest.TestCase):
    def setUp(self):
        self.bus = _FakeBus()
        self.ctx = _FakeCtx(self.bus)
        self.h = _FakeHandler()

    def raise_andon(self, body):
        return api_andon_raise(self.ctx, self.h, _req("/api/andon/raise", body))

    def test_raise_requires_device_identity(self):
        self.raise_andon({"deviceId": "EXO-1", "title": "缺料"})
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_device_identity")
        self.assertEqual(self.bus.published, [])

    def test_raise_requires_title(self):
        self.raise_andon({"deviceId": "device:exo-1"})
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_request")

    def test_raise_emits_andon_raised_envelope(self):
        result = self.raise_andon({
            "deviceId": "device:exo-1",
            "title": "线边缺料",
            "reason": "物料耗尽",
            "severity": "high",
            "assignee": "dispatcher",
            "slaSeconds": 120,
        })
        status, payload = self.h.responses[0]
        self.assertEqual(status, 201)
        self.assertEqual(result["eventType"], "AndonRaised")
        self.assertEqual(self.bus.published[0][0], "events")
        envelope = self.bus.published[0][1]["envelope"]
        self.assertEqual(envelope["eventType"], "AndonRaised")
        self.assertEqual(envelope["source"], "edge:andon")
        self.assertEqual(envelope["subject"], "device:exo-1")
        self.assertEqual(envelope["payload"]["level"], "high")
        self.assertEqual(envelope["payload"]["slaSeconds"], 120)
        self.assertEqual(envelope["payload"]["assignee"], "dispatcher")

    def test_raise_severity_closed_ladder(self):
        self.raise_andon({"deviceId": "device:exo-1", "title": "缺料", "severity": "L2"})
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_severity")
        # canonical 词表直通（critical 合法）
        self.h.responses.clear()
        self.raise_andon({"deviceId": "device:exo-1", "title": "缺料", "severity": "critical"})
        status, _ = self.h.responses[0]
        self.assertEqual(status, 201)

    def test_raise_sla_seconds_validation_and_default(self):
        self.raise_andon({"deviceId": "device:exo-1", "title": "缺料", "slaSeconds": 0})
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_sla_seconds")
        self.h.responses.clear()
        self.raise_andon({"deviceId": "device:exo-1", "title": "缺料"})
        envelope = self.bus.published[0][1]["envelope"]
        self.assertEqual(envelope["payload"]["slaSeconds"], 900)

    def test_raise_bad_json(self):
        req = ReqMeta(
            method="POST", path="/api/andon/raise", path_parts=["api", "andon", "raise"],
            query={}, body="{bad", headers={}, client=("127.0.0.1", 12345),
        )
        api_andon_raise(self.ctx, self.h, req)
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_request")


class RegistryDispatchTest(unittest.TestCase):
    """POST 域分发回归：Round 54 exo POST 分发缺口修复 + andon 域注册。"""

    def setUp(self):
        self.bus = _FakeBus()
        self.ctx = _FakeCtx(self.bus)
        self.h = _FakeHandler()

    def test_post_andon_raise_dispatched(self):
        outcome = dispatch(self.ctx, self.h, "POST", _req("/api/andon/raise", {
            "deviceId": "device:exo-1", "title": "缺料",
        }))
        status, _ = self.h.responses[0]
        self.assertEqual(status, 201)
        self.assertIsNotNone(outcome)

    def test_post_exo_bind_dispatched(self):
        # Round 54 的 exo POST 路由此前未注册进 registry POST 表（直接
        # handler 测试掩盖了分发缺口）；本用例锁死 HTTP 分发路径。
        outcome = dispatch(self.ctx, self.h, "POST", _req("/api/exo/bind", {
            "exoId": "device:exo-1", "personId": "person:p-1",
        }))
        # 无 storage 装配 → handler 返回 503（证明已分发到 exo 域而非 404）
        status, payload = self.h.responses[0]
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "binding_unavailable")
        self.assertIsNotNone(outcome)

    def test_post_unknown_path_not_handled(self):
        from edge_platform.routes import NOT_HANDLED
        outcome = dispatch(self.ctx, self.h, "POST", _req("/api/nope", {}))
        self.assertEqual(outcome, NOT_HANDLED)
        self.assertEqual(self.h.responses, [])


if __name__ == "__main__":
    unittest.main()
