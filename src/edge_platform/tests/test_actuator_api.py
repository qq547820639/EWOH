"""执行机构命令面 API 测试（NO-59b）。

覆盖边缘侧新增端点：
- ``GET  /api/actuators``                       清单（设备信息 + 健康 + 统一状态）
- ``GET  /api/actuators/{deviceId}``            单台状态（未注册 → 404，不返回"空状态"）
- ``POST /api/actuators/{deviceId}/commands``   命令下发（授权 fail-closed + 审计）

钉住的语义：
  1. 未注册设备 404；已注册设备返回真实状态与最近命令；
  2. 高危命令缺授权 → 403（authorization_required），授权号形状非法 → 400
     ——"没给授权"与"给错授权"必须可区分；
  3. `stop` 是安全动作：无授权也 202（安全停机不被审批链卡住）；
  4. 接受与被拒都写审计（actuator.command），命令面绝不"悄悄没发出去"；
  5. 非 JSON / 缺 commandKey / 未知命令 → 400；未启动设备 → 503（传输未就绪）。
"""

import os
import sys
import unittest
from contextlib import contextmanager
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _fixtures import _ServerFixture  # noqa: E402

from edge_platform.edge.adapters.actuator import ACTUATOR_STATES, ActuatorAdapter  # noqa: E402
from edge_platform.edge.adapters.actuator.protocol import authorization_fingerprint_v2  # noqa: E402


class ActuatorApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture(prefix="ewoh_agv_api_")
        cls.adapter = ActuatorAdapter("AGV-01", source_type="simulated", station_id="ST-0")
        cls.adapter.start()
        cls.adapter.transport.register_station("ST-1", 2.0, 0.0)
        cls.fx.ctx.manager.register(cls.adapter)
        # 未启动的第二台：验证 transport_offline（装了但没连上）
        cls.idle_adapter = ActuatorAdapter("AGV-02", source_type="simulated")
        cls.fx.ctx.manager.register(cls.idle_adapter)

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def _audit_actions(self):
        status, _, body = self.fx.req("/api/audit?limit=200")
        self.assertEqual(status, 200)
        items = body.get("items") or body.get("logs") or []
        return [item.get("action") for item in items]

    def test_list_includes_registered_actuators(self):
        status, _, body = self.fx.req("/api/actuators")
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)
        by_id = {item["device_id"]: item for item in body["adapters"]}
        self.assertIn("AGV-01", by_id)
        self.assertEqual(by_id["AGV-01"]["mode"], "actuator")
        self.assertEqual(by_id["AGV-01"]["transport"], "loopback")
        self.assertIn("state", by_id["AGV-01"])
        # 用例共享同一台模拟车（前面的派工用例会推进它）→ 只断言状态在**封闭词表**内，
        # 不依赖用例执行顺序（顺序依赖的断言是自伤，本仓库已踩过）。
        self.assertIn(by_id["AGV-01"]["state"]["state"], ACTUATOR_STATES)
        self.assertEqual(by_id["AGV-01"]["state"]["device_id"], "AGV-01")
        # 命令词表与授权要求如实暴露（页面/联调据此渲染）
        self.assertIn("dispatch_task", by_id["AGV-01"]["command_keys"])
        self.assertIn("dispatch_task", by_id["AGV-01"]["authorization_required_commands"])
        self.assertIn("stop", by_id["AGV-01"]["safety_commands"])

    def test_detail_returns_state_and_recent_commands(self):
        status, _, body = self.fx.req("/api/actuators/AGV-01")
        self.assertEqual(status, 200)
        self.assertEqual(body["device"]["device_id"], "AGV-01")
        self.assertIn("state", body)
        self.assertIsInstance(body["recent_commands"], list)

    def test_unknown_device_is_404_not_empty_state(self):
        status, _, body = self.fx.req("/api/actuators/AGV-404")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "unknown actuator")

    def test_dispatch_without_authorization_is_403(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-01/commands",
            method="POST",
            body={"commandKey": "dispatch_task", "payload": {"targetStationId": "ST-1"}},
        )
        self.assertEqual(status, 403)
        self.assertFalse(body["accepted"])
        self.assertEqual(body["reason"], "authorization_required")
        self.assertIn("actuator.command", self._audit_actions())

    def test_dispatch_with_invalid_authorization_is_400(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-01/commands",
            method="POST",
            body={"commandKey": "dispatch_task", "authorizationRef": "CR-1",
                  "payload": {"targetStationId": "ST-1"}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["reason"], "authorization_ref_invalid")

    def test_dispatch_with_authorization_is_accepted_and_audited(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-01/commands",
            method="POST",
            body={"commandKey": "dispatch_task", "authorizationRef": "control:CR-100",
                  "payload": {"targetStationId": "ST-1", "taskId": "T-100"}},
        )
        self.assertEqual(status, 202)
        self.assertTrue(body["accepted"])
        self.assertEqual(body["state"]["state"], "moving")
        self.assertEqual(body["state"]["business"]["last_authorization_ref"], "control:CR-100")
        self.assertIn("actuator.command", self._audit_actions())

        # 状态读面能看到移动中的事实（同一进程内的回环模拟器推进）
        status, _, detail = self.fx.req("/api/actuators/AGV-01")
        self.assertEqual(status, 200)
        self.assertEqual(detail["state"]["business"]["current_task_id"], "T-100")

    def test_stop_is_safety_command_without_authorization(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-01/commands", method="POST", body={"commandKey": "stop"}
        )
        self.assertEqual(status, 202)
        self.assertTrue(body["accepted"])
        self.assertTrue(body["safety_command"])

    def test_unknown_command_key_is_400(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-01/commands",
            method="POST",
            body={"commandKey": "self_destruct", "authorizationRef": "control:CR-1"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["reason"], "unknown_command_key")

    def test_missing_command_key_is_400(self):
        status, _, body = self.fx.req("/api/actuators/AGV-01/commands", method="POST", body={})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "commandKey is required")

    def test_offline_transport_is_503(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-02/commands",
            method="POST",
            body={"commandKey": "dispatch_task", "authorizationRef": "control:CR-1",
                  "payload": {"targetStationId": "ST-1"}},
        )
        self.assertEqual(status, 503)
        self.assertEqual(body["reason"], "transport_offline")

    def test_unknown_actuator_command_post_is_404(self):
        status, _, body = self.fx.req(
            "/api/actuators/AGV-404/commands",
            method="POST",
            body={"commandKey": "stop"},
        )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "unknown actuator")


class ProductionActuatorAuthorizationTest(unittest.TestCase):
    """Production high-risk HTTP commands cannot be driven by a shaped-but-unapproved ref."""

    SECRET = "edge-control-test-secret"

    def setUp(self):
        self.fx = _ServerFixture(prefix="ewoh_agv_prod_auth_")
        self.adapter = ActuatorAdapter("AGV-PROD", source_type="simulated", station_id="ST-0")
        self.adapter.start()
        self.adapter.transport.register_station("ST-1", 2.0, 0.0)
        self.fx.ctx.manager.register(self.adapter)
        self.responses = []

        class Handler:
            headers = {}
            def send_json(inner_self, payload, status=200):
                self.responses.append((status, payload))
                return payload

        self.h = Handler()

    def tearDown(self):
        self.fx.stop()

    @contextmanager
    def _production(self):
        from edge_platform.routes import actuators as route
        with mock.patch.object(route, "runtime_mode", return_value="production"), mock.patch.dict(
            os.environ, {"EWOH_CONTROL_FINGERPRINT_SECRET": self.SECRET}
        ):
            yield

    def _request(self, body):
        from edge_platform.routes import ReqMeta
        from edge_platform.routes.actuators import api_actuator_command
        return api_actuator_command(
            self.fx.ctx,
            self.h,
            ReqMeta(
                method="POST",
                path="/api/actuators/AGV-PROD/commands",
                path_parts=["api", "actuators", "AGV-PROD", "commands"],
                query={},
                body=body,
                headers={},
                client=("127.0.0.1", 12345),
            ),
        )

    def _proof(self, request_id="CR-PROD-1", approval=None):
        payload = {"targetStationId": "ST-1", "taskId": "T-PROD-1"}
        scope = {
            "requestId": request_id,
            "deviceId": "AGV-PROD",
            "commandKey": "dispatch_task",
            "approvalInstanceId": approval,
        }
        fingerprint = authorization_fingerprint_v2(
            request_id, "AGV-PROD", "dispatch_task", approval, payload, self.SECRET
        )
        return payload, scope, fingerprint

    def test_high_risk_requires_signed_scope_and_rejects_replay(self):
        payload, scope, fingerprint = self._proof()
        base = {
            "requestId": "CR-PROD-1",
            "commandKey": "dispatch_task",
            "authorizationRef": "control:CR-PROD-1",
            "authorizationFingerprint": fingerprint,
            "authorizationScope": scope,
            "payload": payload,
        }
        with self._production():
            self._request(dict(base))
            status, result = self.responses[0]
            self.assertEqual(status, 202)
            self.assertTrue(result["accepted"])
            self._request(dict(base))
        status, replay = self.responses[1]
        self.assertEqual(status, 409)
        self.assertEqual(replay["reason"], "duplicate_command")

        self.responses.clear()
        forged = dict(base)
        forged.pop("authorizationFingerprint")
        with self._production():
            self._request(forged)
        status, denied = self.responses[0]
        self.assertEqual(status, 403)
        self.assertEqual(denied["reason"], "authorization_proof_invalid")

    def test_audit_intent_failure_prevents_high_risk_send(self):
        from unittest.mock import patch
        payload, scope, fingerprint = self._proof("CR-AUDIT-FAIL")
        request = {
            "requestId": "CR-AUDIT-FAIL",
            "commandKey": "dispatch_task",
            "authorizationRef": "control:CR-AUDIT-FAIL",
            "authorizationFingerprint": fingerprint,
            "authorizationScope": scope,
            "payload": payload,
        }
        with self._production(), patch.object(
            self.fx.storage, "insert_audit_log", side_effect=RuntimeError("audit store down")
        ):
            self._request(request)
        status, body = self.responses[0]
        self.assertEqual(status, 503)
        self.assertEqual(body["reason"], "audit_unavailable")
        self.assertFalse(any(entry.get("accepted") for entry in self.adapter.command_log))

    def test_missing_production_secret_fails_closed(self):
        payload, scope, fingerprint = self._proof("CR-NO-SECRET")
        from edge_platform.routes import actuators as route
        with mock.patch.object(route, "runtime_mode", return_value="production"), mock.patch.dict(
            os.environ, {}, clear=False
        ):
            os.environ.pop("EWOH_CONTROL_FINGERPRINT_SECRET", None)
            self._request({
                "requestId": "CR-NO-SECRET",
                "commandKey": "dispatch_task",
                "authorizationRef": "control:CR-NO-SECRET",
                "authorizationFingerprint": fingerprint,
                "authorizationScope": scope,
                "payload": payload,
            })
        status, body = self.responses[0]
        self.assertEqual(status, 503)
        self.assertEqual(body["reason"], "authorization_secret_unconfigured")


if __name__ == "__main__":
    unittest.main()
