"""外骨骼绑定路由测试（ADR-033 / §7：边缘绑定事实一等 API）。

覆盖：bind 规范身份 fail-closed / 活跃绑定唯一冲突 / 落本地账 + 信封事件
发射；unbind 状态机 + ended_by 必填 / 不存在 404 / 重复归还冲突。
直接调用路由 handler（fake ctx/handler），不发真实 HTTP。

纯 Python 标准库 unittest。
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.routes.exo import api_exo_bind, api_exo_unbind  # noqa: E402
from edge_platform.stubs import Storage  # noqa: E402
from edge_platform.routes import ReqMeta  # noqa: E402


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
    def __init__(self, storage, bus):
        self.storage = storage
        self.bus = bus


def _req(body):
    return ReqMeta(
        method="POST", path="/api/exo/bind", path_parts=["api", "exo", "bind"],
        query={}, body=json.dumps(body), headers={}, client=("127.0.0.1", 12345),
    )


class ExoBindingRouteTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "test_exo.db")
        self.storage = Storage(self.db_path)
        self.storage.init_db()
        self.bus = _FakeBus()
        self.ctx = _FakeCtx(self.storage, self.bus)
        self.h = _FakeHandler()

    def tearDown(self):
        self.storage.close()
        self._tmp.cleanup()

    def test_bind_success_and_event_emission(self):
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "person:p-1"}))
        status, payload = self.h.responses[0]
        self.assertEqual(status, 200)
        self.assertTrue(payload["eventEmitted"])
        self.assertEqual(len(self.bus.published), 1)
        topic, evt = self.bus.published[0]
        self.assertEqual(topic, "events")
        self.assertEqual(evt["envelope"]["eventType"], "ExoSessionStarted")
        # 本地账落账
        binding = self.storage.list_active_binding_for_exo("device:exo-1")
        self.assertIsNotNone(binding)
        self.assertEqual(binding["person_id"], "person:p-1")

    def test_bind_rejects_non_canonical_identity(self):
        api_exo_bind(self.ctx, self.h, _req({"exoId": "EXO-1", "personId": "person:p-1"}))
        status, payload = self.h.responses[0]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_exo_identity")
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "P-1"}))
        status2, payload2 = self.h.responses[1]
        self.assertEqual(status2, 400)
        self.assertEqual(payload2["error"], "bad_person_identity")

    def test_bind_active_conflict_explicit(self):
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "person:p-1"}))
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "person:p-2"}))
        status, payload = self.h.responses[1]
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "conflict_exo_binding_active")

    def test_unbind_success_and_event(self):
        api_exo_bind(self.ctx, self.h, _req({
            "exoId": "device:exo-1", "personId": "person:p-1",
            "bindingId": "exo-bind:b1", "sessionId": "exo-session:s1",
        }))
        api_exo_unbind(self.ctx, self.h, _req({
            "bindingId": "exo-bind:b1", "sessionId": "exo-session:s1", "endedBy": "person:op1",
        }))
        status, payload = self.h.responses[1]
        self.assertEqual(status, 200)
        self.assertTrue(payload["eventEmitted"])
        self.assertEqual(self.bus.published[1][1]["envelope"]["eventType"], "ExoSessionEnded")
        self.assertEqual(self.bus.published[1][1]["envelope"]["payload"]["status"], "ended")
        binding = self.storage.get_binding("exo-bind:b1")
        self.assertEqual(binding["status"], "ended")
        self.assertEqual(binding["ended_by"], "person:op1")

    def test_unbind_requires_ended_by(self):
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "person:p-1", "bindingId": "exo-bind:b1"}))
        api_exo_unbind(self.ctx, self.h, _req({"bindingId": "exo-bind:b1", "endedBy": ""}))
        status, payload = self.h.responses[1]
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "ended_by_required")

    def test_unbind_not_found_and_terminal_conflict(self):
        api_exo_unbind(self.ctx, self.h, _req({"bindingId": "exo-bind:ghost", "endedBy": "person:op1"}))
        status, payload = self.h.responses[0]
        self.assertEqual(status, 404)
        # 终态：已结束后再归还 → 409
        api_exo_bind(self.ctx, self.h, _req({"exoId": "device:exo-1", "personId": "person:p-1", "bindingId": "exo-bind:b2"}))
        api_exo_unbind(self.ctx, self.h, _req({"bindingId": "exo-bind:b2", "endedBy": "person:op1"}))
        api_exo_unbind(self.ctx, self.h, _req({"bindingId": "exo-bind:b2", "endedBy": "person:op1"}))
        status2, payload2 = self.h.responses[3]
        self.assertEqual(status2, 409)
        self.assertEqual(payload2["error"], "illegal_transition")


if __name__ == "__main__":
    unittest.main()
