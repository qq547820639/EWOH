"""NO-03b：World Model HTTP 端点测试（routes/replay.py 生产调用链）。

覆盖：/api/world/{snapshot,entities,states,replay,events,predictions} 六端点——
契约 fail-closed（400 + 错误码）、未装配 world_store fail-closed（503）、
声明→状态交叉校验、回放/预测/事件登记、持久化形状。

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_world_api -v
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
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs  # noqa: E402
from edge_platform.world_model.contract_store import ContractWorldStore  # noqa: E402

PERSON_ID = "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"
EXO_ID = "exo:NY-A1-SN-0007"
FACTORY_ID = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"


def _person_declaration():
    return {
        "entityId": PERSON_ID,
        "kind": "person",
        "tenantId": "org-1",
        "factoryId": FACTORY_ID,
        "timeSemantics": {"validFrom": "2026-08-16T08:00:00Z", "validTo": None},
        "status": "active",
        "source": "real",
        "version": 1,
    }


class _WorldServerFixture:
    """共享 server 实例（随机端口），ctx 携带真实 ContractWorldStore。"""

    def __init__(self, with_world_store=True):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_world_api_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        self.world_store = ContractWorldStore() if with_world_store else None
        self.ctx = server.Context(
            self.storage,
            bus=stubs.Bus(),
            world_store=self.world_store,
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

    def req(self, path, method="GET", body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, (json.loads(raw) if raw else {})


class WorldModelEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _WorldServerFixture()
        # 预置合法实体声明，供状态/回放/事件用例使用
        status, body = cls.fx.req("/api/world/entities", "POST", _person_declaration())
        cls._decl_status = status

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_snapshot_contract_shape(self):
        status, body = self.fx.req("/api/world/snapshot")
        self.assertEqual(status, 200)
        self.assertIn("snapshotId", body)
        self.assertIn("entityVersions", body)
        self.assertIn("sourceProfile", body)

    def test_declare_entity_ok_and_fail_closed(self):
        self.assertEqual(self._decl_status, 200)
        status, body = self.fx.req(
            "/api/world/entities",
            "POST",
            {**_person_declaration(), "version": 1},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "declaration_version_not_increasing")
        status, body = self.fx.req(
            "/api/world/entities", "POST", {**_person_declaration(), "kind": "station"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "kind_prefix_mismatch")

    def test_set_state_cross_checks(self):
        status, body = self.fx.req(
            "/api/world/states",
            "POST",
            {
                "entityId": PERSON_ID,
                "entityType": "person",
                "stateJson": {"zone": "Z1"},
                "sourceType": "real",
                "confidence": 1.0,
                "validFrom": "2026-08-16T08:05:00Z",
            },
        )
        self.assertEqual(status, 200)
        # 版本单调（同主键重复写入会递增；用例间共享 server，不做精确版本断言）
        self.assertGreaterEqual(body["state"]["version"], 1)
        # entityType 与声明 kind 不一致 → 400
        status, body = self.fx.req(
            "/api/world/states",
            "POST",
            {"entityId": PERSON_ID, "entityType": "exo", "stateJson": {}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "entity_type_mismatch")
        # 状态生效时间早于声明 → 400
        status, body = self.fx.req(
            "/api/world/states",
            "POST",
            {
                "entityId": PERSON_ID,
                "entityType": "person",
                "stateJson": {},
                "validFrom": "2026-08-16T07:00:00Z",
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "state_precedes_declaration")

    def test_replay_and_events(self):
        status, body = self.fx.req(
            "/api/world/states",
            "POST",
            {
                "entityId": PERSON_ID,
                "entityType": "person",
                "stateJson": {"zone": "Z1"},
                "validFrom": "2026-08-16T08:05:00Z",
            },
        )
        self.assertEqual(status, 200)
        status, body = self.fx.req(
            "/api/world/events",
            "POST",
            {
                "entityId": PERSON_ID,
                "nodeType": "ENTER_ZONE",
                "payload": {"zone_id": "zone:Z-A"},
                "ts": "2026-08-16T08:06:00Z",
            },
        )
        self.assertEqual(status, 200)
        event_id = body["event"]["node_id"]
        status, body = self.fx.req("/api/world/replay?ts=2026-08-16T08:10:00Z")
        self.assertEqual(status, 200)
        self.assertIn(PERSON_ID, body["states"])
        self.assertEqual(body["events"][-1]["node_id"], event_id)
        # 非规范事件主体 → 400
        status, body = self.fx.req(
            "/api/world/events", "POST", {"entityId": "P-1", "nodeType": "ENTER_ZONE"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_event_entity_ref")

    def test_predictions(self):
        status, body = self.fx.req(
            "/api/world/predictions",
            "POST",
            {
                "kind": "fatigue",
                "params": {
                    "personId": PERSON_ID,
                    "currentLoadScore": 85,
                    "loadTrendPerMin": 0.0,
                },
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["prediction"]["prediction_type"], "FATIGUE")
        # 未知类型 → 400
        status, body = self.fx.req(
            "/api/world/predictions", "POST", {"kind": "gizmo", "params": {}}
        )
        self.assertEqual(status, 400)
        # 非规范身份目标 → 400
        status, body = self.fx.req(
            "/api/world/predictions",
            "POST",
            {
                "kind": "fatigue",
                "params": {"personId": "P-1", "currentLoadScore": 85, "loadTrendPerMin": 0.0},
            },
        )
        self.assertEqual(status, 400)


class WorldModelUnavailableTest(unittest.TestCase):
    """world_store 未装配 → 六端点全部 503（fail-closed，绝不静默降级）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _WorldServerFixture(with_world_store=False)

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def test_all_endpoints_503(self):
        for method, path, body in [
            ("GET", "/api/world/snapshot", None),
            ("POST", "/api/world/entities", _person_declaration()),
            ("POST", "/api/world/states", {"entityId": PERSON_ID, "entityType": "person"}),
            ("GET", "/api/world/replay", None),
            ("POST", "/api/world/events", {"entityId": PERSON_ID, "nodeType": "ENTER_ZONE"}),
            ("POST", "/api/world/predictions", {"kind": "fatigue", "params": {}}),
        ]:
            status, body_out = self.fx.req(path, method, body)
            self.assertEqual(status, 503, path)
            self.assertEqual(body_out["error"]["code"], "world_store_unavailable", path)


if __name__ == "__main__":
    unittest.main()
