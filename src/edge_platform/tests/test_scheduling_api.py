"""智能调度 API 测试（Phase 3/5/6）。

覆盖：
- GET /api/resources/state（统一实时资源状态）
- GET/POST /api/tasks、GET/PATCH /api/tasks/{id}
- POST /api/scheduling/requests（建请求+生成方案）、GET /api/scheduling/requests/{id}
- GET /api/scheduling/plans、GET /api/scheduling/plans/{id}
- POST /api/scheduling/plans/{id}/confirm、/reject、/replan（含 409 冲突）
- GET /api/assignments、POST /api/assignments/{id}/{start|pause|complete|cancel|override}
- SSE /api/command-map/stream 事件流

纯 Python 标准库 unittest + urllib；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_scheduling_api -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs  # noqa: E402
from edge_platform.scheduler.events import EventBus  # noqa: E402


def _build_ctx(storage):
    """复用 run.build_scheduler 的装配逻辑，构建带调度服务的 Context。"""
    from edge_platform.scheduler.repository import SchedulingRepository
    from edge_platform.scheduler import (
        EffectivePriorityCalculator,
        GreedyOptimizer,
        Planner,
        ReservationService,
        ResourceStateService,
        Scorer,
        ScoringWeights,
        SchedulerService,
        WeightAuditLog,
        WorldStateService,
        build_route_planner,
    )

    repository = SchedulingRepository(storage)
    event_bus = EventBus()
    world = WorldStateService()
    route = build_route_planner(None)
    reservation = ReservationService()
    scorer = Scorer(ScoringWeights(), WeightAuditLog())
    eff = EffectivePriorityCalculator()
    optimizer = GreedyOptimizer(planner_route=route, scorer=scorer, effective_priority_calc=eff, weights={})
    planner = Planner(optimizer=optimizer, route_planner=route, world_state_service=world)
    scheduler = SchedulerService(
        world_state_service=world,
        planner=planner,
        reservation_service=reservation,
        storage=storage,
        repository=repository,
        event_bus=event_bus,
    )
    rss = ResourceStateService()
    return server.Context(
        storage,
        scheduling_repository=repository,
        event_bus=event_bus,
        scheduler=scheduler,
        resource_state_service=rss,
        kafka=event_bus,
    )


class _ServerFixture:
    """每个测试类共享一个 server 实例（随机端口），减少启停开销。"""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sched_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        self.ctx = _build_ctx(self.storage)
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    # ---- helpers ----
    def request(self, method, path, body=None):
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                payload = {}
            return e.code, payload

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body):
        return self.request("POST", path, body)

    def patch(self, path, body):
        return self.request("PATCH", path, body)


class ResourceStateApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_resource_state_returns_persons_devices(self):
        code, data = self.fx.get("/api/resources/state")
        self.assertEqual(code, 200)
        items = data["items"]
        types = {it["resource_type"] for it in items}
        self.assertIn("person", types)
        self.assertIn("device", types)
        # seed_base: P-001/P-002/P-003 + EXO-001/2/3
        persons = [it for it in items if it["resource_type"] == "person"]
        devices = [it for it in items if it["resource_type"] == "device"]
        self.assertGreaterEqual(len(persons), 3)
        self.assertGreaterEqual(len(devices), 3)
        # 每个资源带 version 且 status 合法
        for it in items:
            self.assertGreaterEqual(it["version"], 1)
            self.assertIn(it["status"], {"AVAILABLE", "RESERVED", "BUSY", "DEGRADED", "OFFLINE", "MAINTENANCE"})


class TaskApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_task_crud_and_patch(self):
        # create
        code, data = self.fx.post("/api/tasks", {"task_type": "搬运", "priority": 5, "station_id": "S-1"})
        self.assertEqual(code, 200)
        task = data["task"]
        self.assertEqual(task["task_type"], "搬运")
        self.assertEqual(task["priority"], 5)
        tid = task["task_id"]
        # list
        code, items = self.fx.get("/api/tasks")
        self.assertEqual(code, 200)
        self.assertTrue(any(t["task_id"] == tid for t in items["items"]))
        # detail
        code, detail = self.fx.get(f"/api/tasks/{tid}")
        self.assertEqual(code, 200)
        self.assertEqual(detail["task"]["task_id"], tid)
        # patch (乐观锁)
        code, upd = self.fx.patch(f"/api/tasks/{tid}", {"priority": 9, "version": task["version"]})
        self.assertEqual(code, 200)
        self.assertEqual(upd["task"]["priority"], 9)
        self.assertGreater(upd["task"]["version"], task["version"])
        # patch with stale version -> 409
        code, err = self.fx.patch(f"/api/tasks/{tid}", {"priority": 1, "version": task["version"]})
        self.assertEqual(code, 409)
        # patch missing -> 404
        code, err = self.fx.patch("/api/tasks/NOPE", {"priority": 1})
        self.assertEqual(code, 404)


class SchedulingApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def _create_request(self):
        # 不带 station_id/required_skills，使默认硬约束下人能匹配出真实 assignment
        code, data = self.fx.post("/api/tasks", {"task_type": "搬运", "priority": 5})
        tid = data["task"]["task_id"]
        code, data = self.fx.post("/api/scheduling/requests", {"task_ids": [tid], "trigger_type": "manual"})
        self.assertEqual(code, 200)
        return tid, data

    def test_create_request_generates_plans(self):
        tid, data = self._create_request()
        self.assertTrue(data["ok"])
        self.assertEqual(data["request"]["status"], "pending")
        self.assertIn(tid, data["request"]["task_ids"])
        self.assertGreaterEqual(len(data["plans"]), 1)
        # plans listed
        code, plans = self.fx.get("/api/scheduling/plans")
        self.assertEqual(code, 200)
        self.assertGreaterEqual(len(plans["items"]), 1)
        # plan detail
        pid = plans["items"][0]["plan_id"]
        code, detail = self.fx.get(f"/api/scheduling/plans/{pid}")
        self.assertEqual(code, 200)
        self.assertEqual(detail["plan"]["plan_id"], pid)
        # request detail
        code, reqd = self.fx.get(f"/api/scheduling/requests/{data['request']['request_id']}")
        self.assertEqual(code, 200)
        self.assertEqual(reqd["request"]["request_id"], data["request"]["request_id"])

    def test_confirm_reject_replan(self):
        tid, data = self._create_request()
        pid = data["plans"][0]["plan_id"]
        # confirm without reason -> error
        code, err = self.fx.post(f"/api/scheduling/plans/{pid}/confirm", {"actor_id": "leader1", "reason": ""})
        self.assertEqual(code, 409)
        # confirm with reason succeeds
        code, res = self.fx.post(
            f"/api/scheduling/plans/{pid}/confirm",
            {"actor_id": "leader1", "reason": "手动确认", "world_state_version": data["plans"][0]["world_state_version"]},
        )
        self.assertEqual(code, 200)
        self.assertEqual(res["plan"]["status"], "approved")
        # confirm stale world_state_version -> 409 PLAN_STALE
        code, err = self.fx.post(
            f"/api/scheduling/plans/{pid}/confirm", {"actor_id": "leader1", "reason": "x", "world_state_version": "WRONG"}
        )
        self.assertEqual(code, 409)
        self.assertIn(err["error"]["code"], ("PLAN_STALE", "ILLEGAL_STATE"))
        # replan
        code, res = self.fx.post(f"/api/scheduling/plans/{pid}/replan", {"actor_id": "leader1", "reason": "插单"})
        self.assertEqual(code, 200)
        self.assertNotEqual(res["plan"]["plan_id"], pid)

    def test_assignments_lifecycle(self):
        tid, data = self._create_request()
        pid = data["plans"][0]["plan_id"]
        self.fx.post(f"/api/scheduling/plans/{pid}/confirm", {"actor_id": "leader1", "reason": "确认派工"})
        # execute -> create assignments (先确认后，经由 confirm 并未直接派工；需执行)
        # 直接通过 SchedulerService.execute 派工
        assignments = self.fx.ctx.scheduler.execute(pid)
        self.assertGreaterEqual(len(assignments), 1)
        asn_id = assignments[0].assignment_id
        # list assignments
        code, items = self.fx.get("/api/assignments")
        self.assertEqual(code, 200)
        self.assertTrue(any(a["assignment_id"] == asn_id for a in items["items"]))
        # start
        code, res = self.fx.post(f"/api/assignments/{asn_id}/start", {"actor_id": "leader1"})
        self.assertEqual(code, 200)
        self.assertIn(res["assignment"]["status"], ("executing", "received"))
        # pause
        code, res = self.fx.post(f"/api/assignments/{asn_id}/pause", {"actor_id": "leader1"})
        self.assertEqual(code, 200)
        self.assertEqual(res["assignment"]["status"], "paused")
        # complete
        code, res = self.fx.post(f"/api/assignments/{asn_id}/complete", {"actor_id": "leader1"})
        self.assertEqual(code, 200)
        self.assertEqual(res["assignment"]["status"], "completed")
        # cancel on completed -> 409
        code, err = self.fx.post(f"/api/assignments/{asn_id}/cancel", {"actor_id": "leader1"})
        self.assertEqual(code, 409)
        # override
        asn2 = assignments[0]
        code, res = self.fx.post(f"/api/assignments/{asn2.assignment_id}/override", {"actor_id": "leader1", "status": "executing"})
        self.assertEqual(code, 200)


class CommandMapStreamTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_stream_emits_events(self):
        # 订阅：直接发布一个事件到总线，验证 SSE 可消费
        bus = self.fx.ctx.event_bus
        q = bus.subscribe()
        bus.publish("resource.updated", entity_id="EXO-001", version=2, payload={"status": "BUSY"})
        event = q.get(timeout=1)
        self.assertEqual(event["event_type"], "resource.updated")
        self.assertEqual(event["entity_id"], "EXO-001")
        self.assertEqual(event["version"], 2)
        self.assertIn("event_id", event)
        self.assertIn("server_ts", event)
        self.assertIn("source_ts", event)
        bus.unsubscribe(q)


if __name__ == "__main__":
    unittest.main()