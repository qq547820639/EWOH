"""P0-SCHED-OWNERSHIP 测试：Edge advisory 模式与仓储只读守卫。

覆盖：
- advisory_only=True：generate_plans 产出 advisory 标记方案；
  confirm/execute/replan/feedback/set_assignment_status 全部拒绝（AdvisoryOnlyError）；
- SchedulingRepository(readonly=True)：写方法抛 ReadonlyModeError，读方法可用；
- run.py build_scheduler 模式解析：simulation → 可写；production/development → advisory；
  EWOH_EDGE_SCHEDULING_WRITE=1 → 可写（仅限 development/test/simulation，本地联调）；
  13.1：production + EWOH_EDGE_SCHEDULING_WRITE=1 → fail-closed 抛配置错误。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.run import (
    SchedulingWriteProhibitedError,
    build_scheduler,
    ensure_scheduling_write_permitted,
    scheduling_write_allowed_in_mode,
)
from edge_platform.scheduler import (
    EffectivePriorityCalculator,
    GreedyOptimizer,
    Planner,
    ReservationService,
    SchedulerService,
    Scorer,
    ScoringWeights,
    WeightAuditLog,
    WorldStateService,
    build_route_planner,
)
from edge_platform.scheduler.models import SchedulePlan
from edge_platform.scheduler.repository import (
    ReadonlyModeError,
    SchedulingRepository,
)
from edge_platform.scheduler.scheduler_service import AdvisoryOnlyError


class _FakeWorldStorage:
    """最小假 storage：person/device 数据源 + 调度记录读写接口。"""

    def __init__(self):
        self.persons = [
            {"person_id": "P1", "location": {"station_id": "S1"}},
            {"person_id": "P2", "location": {"station_id": "S1"}},
        ]
        self.devices = [{"device_id": "D1"}, {"device_id": "D2"}]
        self.plans = {}

    def list_people(self):
        return self.persons

    def list_persons(self):
        return self.persons

    def list_devices(self):
        return self.devices

    def list_tasks(self):
        return []

    def list_stations(self):
        return [{"station_id": "S1"}]

    def list_assignments(self):
        return []

    def list_events(self, limit=200):
        return []

    def list_reservations(self):
        return []

    def list_schedule_plans(self, status=None):
        return list(self.plans.values())

    def save_schedule_plan(self, plan_id, **fields):
        self.plans[plan_id] = fields
        return fields


class _FakeRepository:
    """记录写调用的假 repository（验证 advisory 模式下不触发写）。"""

    def __init__(self):
        self.writes = []

    def save_plan(self, plan):
        self.writes.append(("save_plan", plan.plan_id))

    def save_snapshot(self, snapshot):
        self.writes.append(("save_snapshot", getattr(snapshot, "snapshot_id", None)))

    def save_request(self, req):
        self.writes.append(("save_request", getattr(req, "request_id", None)))

    def save_assignment(self, a):
        self.writes.append(("save_assignment", getattr(a, "assignment_id", None)))

    def save_reservation(self, res):
        self.writes.append(("save_reservation", getattr(res, "reservation_id", None)))

    def save_feedback(self, fb):
        self.writes.append(("save_feedback", getattr(fb, "feedback_id", None)))

    def record_decision(self, *args, **kwargs):
        self.writes.append(("record_decision", args))


def _make_scheduler(advisory_only=False, repository=None):
    """装配 SchedulerService（注入假 world storage）。"""
    world = WorldStateService()
    route = build_route_planner(None)
    reservation = ReservationService()
    scorer = Scorer(ScoringWeights(), WeightAuditLog())
    eff = EffectivePriorityCalculator()
    optimizer = GreedyOptimizer(
        planner_route=route,
        scorer=scorer,
        effective_priority_calc=eff,
        weights={},
    )
    planner = Planner(
        optimizer=optimizer,
        route_planner=route,
        world_state_service=world,
    )
    return SchedulerService(
        world_state_service=world,
        planner=planner,
        reservation_service=reservation,
        storage=_FakeWorldStorage(),
        repository=repository,
        event_bus=None,
        advisory_only=advisory_only,
    )


def _make_approved_plan(scheduler):
    """生成并确认一个方案（非 advisory 模式下），返回 plan_id。"""
    req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
    plans = scheduler.generate_plans(req.request_id)
    assert plans, "generate_plans 应产出至少一个方案"
    plan = plans[0]
    scheduler.confirm(
        plan.plan_id,
        "leader1",
        "ok",
        world_state_version=getattr(plan, "world_state_version", None),
    )
    return plan.plan_id


class AdvisoryOnlyGuardTest(unittest.TestCase):
    """advisory_only=True 时所有写路径必须拒绝（403 语义）。"""

    def test_generate_plans_marks_advisory(self):
        repo = _FakeRepository()
        scheduler = _make_scheduler(advisory_only=True, repository=repo)
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        self.assertTrue(plans)
        for plan in plans:
            self.assertTrue(getattr(plan, "advisory", False), "advisory 方案必须带 advisory 标记")
            d = plan.to_dict()
            self.assertTrue(d.get("advisory") is True)
            self.assertIn("advisory_note", d)
        # advisory 模式：不触发任何仓储写
        self.assertEqual(repo.writes, [])

    def test_confirm_rejected_in_advisory(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        with self.assertRaises(AdvisoryOnlyError) as ctx:
            scheduler.confirm(plans[0].plan_id, "leader", "approve")
        self.assertEqual(ctx.exception.code, "SCHEDULING_READ_ONLY")

    def test_execute_rejected_in_advisory(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        with self.assertRaises(AdvisoryOnlyError):
            scheduler.execute(plans[0].plan_id)

    def test_replan_rejected_in_advisory(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        with self.assertRaises(AdvisoryOnlyError):
            scheduler.replan(plans[0].plan_id, "manual", "leader", "reschedule")

    def test_feedback_rejected_in_advisory(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        with self.assertRaises(AdvisoryOnlyError):
            scheduler.feedback(plans[0].plan_id, {"actual_start": "x"})

    def test_set_assignment_status_rejected_in_advisory(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        with self.assertRaises(AdvisoryOnlyError):
            scheduler.set_assignment_status("ASN-1", "executing", "leader", force=True)

    def test_reconcile_discards_local_state(self):
        scheduler = _make_scheduler(advisory_only=True, repository=_FakeRepository())
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        scheduler.generate_plans(req.request_id)
        self.assertTrue(scheduler._plans)
        result = scheduler.reconcile_from_cloud()
        self.assertTrue(result["discarded"])
        self.assertTrue(result["advisory_only"])
        self.assertEqual(scheduler._plans, {})
        self.assertEqual(scheduler._requests, {})


class WritableModeStillWorksTest(unittest.TestCase):
    """非 advisory（simulation / 显式授权）保持完整闭环。"""

    def test_confirm_works_when_writable(self):
        scheduler = _make_scheduler(advisory_only=False)
        plan_id = _make_approved_plan(scheduler)
        # confirm 成功 → 状态推进为 approved
        plan = scheduler._get_plan(plan_id)
        self.assertEqual(plan.status, "approved")

    def test_advisory_flag_absent_when_writable(self):
        scheduler = _make_scheduler(advisory_only=False)
        req = scheduler.create_request(["T1"], "manual", "policy-1", "tester")
        plans = scheduler.generate_plans(req.request_id)
        self.assertFalse(getattr(plans[0], "advisory", False))
        self.assertNotIn("advisory", plans[0].to_dict())


class ReadonlyRepositoryGuardTest(unittest.TestCase):
    """readonly 仓储：读可用、写全部拒绝。"""

    def _repo(self):
        class _Storage:
            def __init__(self):
                self._plans = {}

            def get_task(self, task_id):
                return None

            def list_tasks(self, status=None):
                return []

            def list_schedule_plans(self, status=None):
                return list(self._plans.values())

        return SchedulingRepository(_Storage(), readonly=True)

    def test_read_methods_available(self):
        repo = self._repo()
        self.assertEqual(repo.list_plans(), [])
        self.assertEqual(repo.list_tasks(), [])
        self.assertIsNone(repo.get_task("T1"))

    def test_write_methods_rejected(self):
        repo = self._repo()
        with self.assertRaises(ReadonlyModeError):
            repo.save_plan(SchedulePlan(plan_id="PLN-1"))
        with self.assertRaises(ReadonlyModeError):
            repo.save_request({"request_id": "REQ-1"})
        with self.assertRaises(ReadonlyModeError):
            repo.save_task({"task_id": "T1"})
        with self.assertRaises(ReadonlyModeError):
            repo.save_reservation({"reservation_id": "RES-1"})
        with self.assertRaises(ReadonlyModeError):
            repo.save_feedback({"feedback_id": "FB-1"})
        with self.assertRaises(ReadonlyModeError):
            repo.save_snapshot({"snapshot_id": "WS-1"})
        with self.assertRaises(ReadonlyModeError):
            repo.record_decision("P1", 1, "confirm", "u", "r", None, None)
        with self.assertRaises(ReadonlyModeError):
            repo.update_task("T1", 1, status="executing")
        with self.assertRaises(ReadonlyModeError):
            repo.update_reservation("RES-1", 1, status="closed")


class RunPyOwnershipResolutionTest(unittest.TestCase):
    """run.py build_scheduler 的 ownership 解析（production/development/simulation）。"""

    def test_simulation_is_writable(self):
        scheduler = _make_scheduler(advisory_only=False)
        self.assertFalse(scheduler.advisory_only)

    def test_advisory_only_flag_propagates(self):
        scheduler = _make_scheduler(advisory_only=True)
        self.assertTrue(scheduler.advisory_only)
        self.assertEqual(scheduler.advisory_only, True)


class SchedulingWriteFailClosedTest(unittest.TestCase):
    """13.1：production 写禁止（fail-closed）+ 非生产模式显式写仍可用。

    覆盖：
    - production（或任何非 simulation/development/test 模式）+ EWOH_EDGE_SCHEDULING_WRITE=1
      → 启动即抛 SchedulingWriteProhibitedError（不允许静默降级为 advisory）；
    - development/test/simulation + EWOH_EDGE_SCHEDULING_WRITE=1 → 可写；
    - 无环境变量 → advisory-only 默认。
    """

    def setUp(self):
        self._old_write = os.environ.get("EWOH_EDGE_SCHEDULING_WRITE")
        os.environ.pop("EWOH_EDGE_SCHEDULING_WRITE", None)

    def tearDown(self):
        os.environ.pop("EWOH_EDGE_SCHEDULING_WRITE", None)
        if self._old_write is not None:
            os.environ["EWOH_EDGE_SCHEDULING_WRITE"] = self._old_write

    def _build(self, mode, write):
        """按 mode + write 标志装配 build_scheduler，返回 (scheduler, resource_state_service)。"""
        if write:
            os.environ["EWOH_EDGE_SCHEDULING_WRITE"] = "1"
        else:
            os.environ.pop("EWOH_EDGE_SCHEDULING_WRITE", None)
        return build_scheduler(_FakeWorldStorage(), None, None, mode=mode, advisory_only=True)

    def test_production_write_env_fails_closed(self):
        with self.assertRaises(SchedulingWriteProhibitedError) as ctx:
            self._build("production", write=True)
        msg = str(ctx.exception)
        self.assertIn("EWOH_EDGE_SCHEDULING_WRITE", msg)
        self.assertIn("production", msg)
        self.assertIn("development", msg)  # 提示仅限非生产模式

    def test_unknown_mode_write_env_fails_closed(self):
        # 任何非 simulation/development/test 模式都按生产语义 fail-closed
        with self.assertRaises(SchedulingWriteProhibitedError):
            self._build("staging", write=True)
        with self.assertRaises(SchedulingWriteProhibitedError):
            self._build("", write=True)

    def test_development_write_env_writable(self):
        scheduler, _ = self._build("development", write=True)
        self.assertFalse(scheduler.advisory_only)

    def test_test_mode_write_env_writable(self):
        scheduler, _ = self._build("test", write=True)
        self.assertFalse(scheduler.advisory_only)

    def test_simulation_write_env_writable(self):
        scheduler, _ = self._build("simulation", write=True)
        self.assertFalse(scheduler.advisory_only)

    def test_production_no_env_advisory_default(self):
        scheduler, _ = self._build("production", write=False)
        self.assertTrue(scheduler.advisory_only)

    def test_no_env_advisory_default(self):
        scheduler, _ = self._build("development", write=False)
        self.assertTrue(scheduler.advisory_only)

    def test_helpers_contract(self):
        # 辅助函数直接契约
        self.assertTrue(scheduling_write_allowed_in_mode("development"))
        self.assertTrue(scheduling_write_allowed_in_mode("TEST"))
        self.assertTrue(scheduling_write_allowed_in_mode("simulation"))
        self.assertFalse(scheduling_write_allowed_in_mode("production"))
        self.assertFalse(scheduling_write_allowed_in_mode("staging"))
        os.environ["EWOH_EDGE_SCHEDULING_WRITE"] = "1"
        with self.assertRaises(SchedulingWriteProhibitedError):
            ensure_scheduling_write_permitted("production")
        # 非生产模式不抛
        ensure_scheduling_write_permitted("development")


if __name__ == "__main__":
    unittest.main()
