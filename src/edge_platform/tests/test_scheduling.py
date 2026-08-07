"""联合智能调度核心（Task 8.1）单元测试。

覆盖新模块（区别于 test_scheduler.py 的旧单任务 orchestrator）：
- DomainTests：Task/Plan 状态机、ResourceState、Reservation、乐观锁版本冲突。
- ConstraintTests：HardConstraints 各项硬约束 + Reservation 时间冲突 + station capacity。
- RoutingTests：Topology 最短路径、GraphRoutePlanner、不可达、Euclidean 回退。
- SchedulingTests：GreedyOptimizer 产出 assignment（单/多/高优先/deadline/资源不足/依赖/aging/时间重叠）。
- HITLTests：SchedulerService 人在回路（未确认不可执行、确认必须带理由、stale、reject 后不可执行、confirmed 可执行）。
- ReplanTests：Replanner.diff 差异 + replan 冻结 frozen 分配 + 资源剔除非可达。
- APITests：SchedulerService 直接调用 create_task/create_request/generate_plans/confirm/reject/replan/assignment 生命周期。

纯 unittest 标准库，无网络、无外部依赖、确定性。
运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_scheduling -v
"""

import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler import (  # noqa: E402
    DEVICE_FAULT,
    EXO_MODEL_COMPAT,
    FORBIDDEN_ZONE,
    # 领域模型与状态机
    PLAN_APPROVED,
    PLAN_ARCHIVED,
    PLAN_PENDING_REVIEW,
    PLAN_SHADOW,
    PLAN_SIMULATING,
    RESOURCE_AVAILABLE,
    RESOURCE_OFFLINE,
    SAFETY,
    SHIFT_REST,
    SKILL,
    STATION_AUTH,
    TASK_CANCELLED,
    TASK_COMPLETED,
    TASK_DISPATCHED,
    TASK_DRAFT,
    TASK_EXECUTING,
    TASK_PENDING_DISPATCH,
    TASK_RECEIVED,
    Assignment,
    CandidateAssignment,
    # 约束 / 候选 / 评分
    ConstraintViolation,
    # 优先级 / 路线 / 拓扑
    EffectivePriorityCalculator,
    EuclideanRoutePlanner,
    GraphRoutePlanner,
    # 优化 / 规划 / 重排 / 服务
    GreedyOptimizer,
    HardConstraints,
    # 异常
    IllegalStateError,
    Planner,
    PlanStaleError,
    Replanner,
    # 预约 / 版本冲突
    ReservationConflictError,
    ReservationService,
    ResourceState,
    SchedulePlan,
    SchedulerService,
    SchedulingRepository,
    Scorer,
    ScoringWeights,
    Task,
    VersionConflictError,
    WeightAuditLog,
    WorldStateService,
    build_route_planner,
    validate_plan_transition,
    validate_task_transition,
)
from edge_platform.spatial.topology import Topology, TopologyEdge, TopologyNode  # noqa: E402

# ---------------------------------------------------------------------------
# 测试装配辅助
# ---------------------------------------------------------------------------

def _make_optimizer(constraints=None):
    """构造带默认组件的 GreedyOptimizer（欧氏路线、默认评分与有效优先级）。"""
    route = build_route_planner(None)
    scorer = Scorer(ScoringWeights(), WeightAuditLog())
    eff = EffectivePriorityCalculator()
    return GreedyOptimizer(
        planner_route=route,
        scorer=scorer,
        effective_priority_calc=eff,
        weights={},
        constraints=constraints,
    )


def _make_world_state(persons, devices, snapshot_id="WS-TEST-0001"):
    """构造满足 GreedyOptimizer.solve 的最小世界状态假对象。"""
    return SimpleNamespace(snapshot_id=snapshot_id, persons=list(persons), devices=list(devices))


def _person(pid, station_id="S1"):
    return {"person_id": pid, "location": {"station_id": station_id}}


def _device(did):
    return {"device_id": did}


def _task(tid, **overrides):
    task = {
        "task_id": tid,
        "estimated_duration_sec": 600,
        "earliest_start": "2026-01-01T08:00:00+00:00",
    }
    task.update(overrides)
    return task


class _FakeWorldStorage:
    """提供人员/设备等数据源的最小假 storage，使 SchedulerService 产出真实 assignment。"""

    def __init__(self):
        self.persons = [_person("P1"), _person("P2")]
        self.devices = [_device("D1"), _device("D2")]

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
        return []


def _make_scheduler(event_bus=None):
    """装配 SchedulerService（注入假 world storage，无 repository，纯内存）。"""
    world = WorldStateService()
    route = build_route_planner(None)
    reservation = ReservationService()
    optimizer = _make_optimizer()
    planner = Planner(optimizer=optimizer, route_planner=route, world_state_service=world)
    scheduler = SchedulerService(
        world_state_service=world,
        planner=planner,
        reservation_service=reservation,
        storage=_FakeWorldStorage(),
        replanner=Replanner(planner),
        repository=None,
        event_bus=event_bus,
    )
    return scheduler


class _FakeTaskStorage:
    """仅实现 SchedulingRepository.update_task 所需的最小假 storage。"""

    def __init__(self):
        self._tasks = {}

    def upsert_task(self, task_id, **fields):
        d = dict(fields)
        d["task_id"] = task_id
        self._tasks[task_id] = d
        return d

    def get_task(self, task_id):
        return self._tasks.get(task_id)

    def list_tasks(self, status=None):
        items = list(self._tasks.values())
        if status:
            items = [t for t in items if t.get("status") == status]
        return items


# ---------------------------------------------------------------------------
# 1. 领域模型与状态机
# ---------------------------------------------------------------------------

class DomainTests(unittest.TestCase):
    def test_task_legal_transition_passes(self):
        # pending_dispatch -> dispatched 合法
        self.assertTrue(validate_task_transition(TASK_PENDING_DISPATCH, TASK_DISPATCHED))
        # 沿主链推进各步也应合法
        self.assertTrue(validate_task_transition(TASK_DRAFT, "pending_confirm"))
        self.assertTrue(validate_task_transition(TASK_RECEIVED, TASK_EXECUTING))

    def test_task_illegal_transition_raises(self):
        # draft -> executing 非法
        with self.assertRaises(ValueError):
            validate_task_transition(TASK_DRAFT, TASK_EXECUTING)
        # 已终止态不可再转
        with self.assertRaises(ValueError):
            validate_task_transition(TASK_COMPLETED, TASK_EXECUTING)

    def test_task_non_terminal_to_cancelled_allowed(self):
        # 契约特例：任意非终止态 -> cancelled 允许
        self.assertTrue(validate_task_transition(TASK_PENDING_DISPATCH, TASK_CANCELLED))
        self.assertTrue(validate_task_transition(TASK_EXECUTING, TASK_CANCELLED))

    def test_plan_legal_transition_passes(self):
        self.assertTrue(validate_plan_transition(PLAN_PENDING_REVIEW, PLAN_APPROVED))
        self.assertTrue(validate_plan_transition(PLAN_SIMULATING, PLAN_PENDING_REVIEW))

    def test_plan_shadow_to_approved_invalid(self):
        # 单测 validate_plan_transition：shadow -> approved 本身不合法（契约需经 simulating/pending_review）
        with self.assertRaises(ValueError):
            validate_plan_transition(PLAN_SHADOW, PLAN_APPROVED)

    def test_plan_any_to_archived_allowed(self):
        # 通用归档路径
        self.assertTrue(validate_plan_transition(PLAN_SHADOW, PLAN_ARCHIVED))
        self.assertTrue(validate_plan_transition(PLAN_APPROVED, PLAN_ARCHIVED))

    def test_resource_state_defaults_and_to_dict(self):
        r = ResourceState(resource_id="P-1", resource_type="person")
        self.assertEqual(r.status, RESOURCE_AVAILABLE)
        self.assertEqual(r.version, 1)
        self.assertTrue(r.updated_at)  # __post_init__ 自动填充
        d = r.to_dict()
        self.assertEqual(d["resource_id"], "P-1")
        self.assertEqual(d["status"], RESOURCE_AVAILABLE)
        self.assertEqual(d["version"], 1)
        self.assertIn("updated_at", d)

    def test_reservation_reserve_success_and_conflict(self):
        svc = ReservationService()
        res = svc.reserve("R1", "ASN-1", "PLN-1", "2099-01-01T08:00:00+00:00", "2099-01-01T09:00:00+00:00", "2099-01-01T10:00:00+00:00")
        self.assertEqual(res.status, "active")
        self.assertEqual(res.version, 1)
        # 半开区间端点相接不算冲突
        self.assertFalse(svc.check_conflict("R1", "2099-01-01T09:00:00+00:00", "2099-01-01T10:00:00+00:00"))
        # 时间窗重叠 -> 冲突
        with self.assertRaises(ReservationConflictError):
            svc.reserve("R1", "ASN-2", "PLN-1", "2099-01-01T08:30:00+00:00", "2099-01-01T09:30:00+00:00", "2099-01-01T10:00:00+00:00")

    def test_reservation_release_frees_conflict(self):
        svc = ReservationService()
        res = svc.reserve("R1", "ASN-1", "PLN-1", "2099-01-01T08:00:00+00:00", "2099-01-01T09:00:00+00:00", "2099-01-01T10:00:00+00:00")
        svc.release(res.reservation_id)
        # release 后不再冲突
        self.assertFalse(svc.check_conflict("R1", "2099-01-01T08:30:00+00:00", "2099-01-01T09:30:00+00:00"))

    def test_reservation_expire_overdue(self):
        svc = ReservationService()
        res = svc.reserve("R1", "ASN-1", "PLN-1", "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2020-01-01T00:00:00+00:00")
        expired = svc.expire_overdue(now="2026-01-01T12:00:00+00:00")
        self.assertIn(res, expired)
        # 过期后不再参与 active
        self.assertNotIn(res, svc.list_active())

    def test_version_conflict_raises(self):
        repo = SchedulingRepository(_FakeTaskStorage())
        repo.save_task(Task(task_id="T1", priority=1))
        # 匹配版本 -> 成功并自增
        updated = repo.update_task("T1", 1, priority=9)
        self.assertEqual(updated["version"], 2)
        # 过期版本 -> VersionConflictError
        with self.assertRaises(VersionConflictError):
            repo.update_task("T1", 1, priority=5)


# ---------------------------------------------------------------------------
# 2. 硬约束
# ---------------------------------------------------------------------------

class ConstraintTests(unittest.TestCase):
    def assert_violation_types(self, hc, person, task, device, ctx, expected):
        viols = hc.check(person, task, device, ctx)
        types = {v.constraint_type for v in viols}
        self.assertTrue(expected.issubset(types), f"期望约束 {expected}，实际 {types}")

    def test_skill_missing(self):
        hc = HardConstraints(skills_registry={"P1": {"搬运"}})
        person = {"person_id": "P1"}
        task = {"task_id": "T1", "required_skills": ["焊接"]}
        self.assert_violation_types(hc, person, task, {}, None, {SKILL})

    def test_station_auth_missing(self):
        hc = HardConstraints(station_auth={"P1": {"S1"}})
        person = {"person_id": "P1"}
        task = {"task_id": "T1", "station_id": "S9"}
        self.assert_violation_types(hc, person, task, {}, None, {STATION_AUTH})

    def test_exo_compat_incompatible(self):
        hc = HardConstraints(exo_compat={"EXO-A": {"lift"}})
        person = {"person_id": "P1"}
        task = {"task_id": "T1", "exo_requirements": ["lift", "heavy"]}
        device = {"device_id": "D1", "model": "EXO-A"}
        self.assert_violation_types(hc, person, task, device, None, {EXO_MODEL_COMPAT})

    def test_device_fault(self):
        hc = HardConstraints(device_faults={"D1"})
        person = {"person_id": "P1"}
        task = {"task_id": "T1"}
        device = {"device_id": "D1"}
        self.assert_violation_types(hc, person, task, device, None, {DEVICE_FAULT})

    def test_forbidden_zone(self):
        hc = HardConstraints(forbidden_zones={"Z1"})
        person = {"person_id": "P1"}
        task = {"task_id": "T1", "zone_id": "Z1"}
        self.assert_violation_types(hc, person, task, {}, None, {FORBIDDEN_ZONE})

    def test_shift_rest_continuous(self):
        hc = HardConstraints(shift_rules={"day": {"max_continuous_minutes": 120}})
        person = {"person_id": "P1", "shift_id": "day"}
        task = {"task_id": "T1"}
        self.assert_violation_types(hc, person, task, {}, {"continuous_minutes": 180}, {SHIFT_REST})

    def test_shift_rest_per_hour(self):
        hc = HardConstraints(shift_rules={"day": {"rest_minutes_per_hour": 10}})
        person = {"person_id": "P1", "shift_id": "day"}
        task = {"task_id": "T1"}
        self.assert_violation_types(hc, person, task, {}, {"minutes_worked_current_hour": 55}, {SHIFT_REST})

    def test_safety_block(self):
        hc = HardConstraints()
        person = {"person_id": "P1"}
        task = {"task_id": "T1"}
        self.assert_violation_types(hc, person, task, {}, {"safety_block": True}, {SAFETY})

    def test_safety_critical_requires_approval(self):
        hc = HardConstraints()
        person = {"person_id": "P1"}
        task = {"task_id": "T1", "safety_critical": True}
        # 未授权 → 违规
        self.assert_violation_types(hc, person, task, {}, {"safety_approved_persons": set()}, {SAFETY})
        # 已授权 → 通过
        self.assertEqual(hc.check(person, task, {}, {"safety_approved_persons": {"P1"}}), [])

    def test_constraint_violation_validates_type(self):
        with self.assertRaises(ValueError):
            ConstraintViolation("NOT_A_TYPE", "P1", "bad")

    def test_reservation_time_conflict_and_station_occupancy(self):
        # Reservation 时间冲突（同一资源）断言抛错
        svc = ReservationService()
        svc.reserve("S1", "ASN-1", "PLN-1", "2099-01-01T08:00:00+00:00", "2099-01-01T09:00:00+00:00", "2099-01-01T10:00:00+00:00")
        self.assertTrue(svc.check_conflict("S1", "2099-01-01T08:30:00+00:00", "2099-01-01T09:30:00+00:00"))

        # station capacity：同一工位同一时间窗叠占 → 第二个任务被跳过（occ 逻辑）
        opt = _make_optimizer()
        ws = _make_world_state([_person("P1")], [_device("D1")])
        t1 = _task("T1", station_id="S1")
        t2 = _task("T2", station_id="S1", earliest_start="2026-01-01T08:00:00+00:00")  # 与 T1 同工位同时间窗
        # 授予工位授权，避免 STATION_AUTH 拦截，真正测工位占用
        hc = HardConstraints(station_auth={"P1": {"S1"}})
        opt = _make_optimizer(constraints=hc)
        plan = opt.solve(ws, [t1, t2], None, {})
        assigned = {a.task_id for a in plan.assignments}
        self.assertGreaterEqual(len(assigned), 1)  # 至少分配一个
        self.assertLessEqual(len(assigned), 1)  # 同工位占用导致第二个被跳过

    def test_device_offline_status_and_fault(self):
        # 设备离线状态可由 ResourceState 的 OFFLINE 表达，且 device_faults 拦截
        dev = ResourceState(resource_id="D1", resource_type="device", status=RESOURCE_OFFLINE)
        self.assertEqual(dev.status, RESOURCE_OFFLINE)
        # 故障设备被硬约束拦截
        hc = HardConstraints(device_faults={"D1"})
        viols = hc.check({"person_id": "P1"}, {"task_id": "T1"}, {"device_id": "D1"}, None)
        self.assertTrue(any(v.constraint_type == DEVICE_FAULT for v in viols))


# ---------------------------------------------------------------------------
# 3. 路线规划
# ---------------------------------------------------------------------------

class RoutingTests(unittest.TestCase):
    def _make_topology(self):
        topo = Topology()
        for n in ("A", "B", "C", "D"):
            topo.add_node(TopologyNode(node_id=n))
        topo.add_edge(TopologyEdge("A", "B", 10.0))
        topo.add_edge(TopologyEdge("B", "C", 20.0))
        topo.add_edge(TopologyEdge("A", "C", 100.0))
        # D 孤立，不可达
        return topo

    def test_shortest_path(self):
        topo = self._make_topology()
        dist, path = topo.shortest_path("A", "C")
        self.assertEqual(dist, 30.0)
        self.assertEqual(path, ["A", "B", "C"])

    def test_graph_planner_route_distance(self):
        topo = self._make_topology()
        planner = GraphRoutePlanner(topo, walk_speed_m_per_s=1.0)
        route = planner.calculate_route({"station_id": "A"}, "C")
        self.assertTrue(route.reachable)
        self.assertEqual(route.distance_m, 30.0)
        self.assertEqual(route.nodes, ["A", "B", "C"])
        self.assertEqual(route.eta_sec, 30)

    def test_unreachable(self):
        topo = self._make_topology()
        planner = GraphRoutePlanner(topo)
        route = planner.calculate_route({"station_id": "A"}, "D")
        self.assertFalse(route.reachable)
        self.assertTrue(route.blocked_reason)

    def test_euclidean_fallback(self):
        planner = EuclideanRoutePlanner()
        route = planner.calculate_route({"x": 0, "y": 0}, {"x": 3, "y": 4})
        self.assertTrue(route.reachable)
        self.assertAlmostEqual(route.distance_m, 5.0, places=6)
        self.assertEqual(route.eta_sec, 5)

    def test_build_route_planner_factory(self):
        self.assertIsInstance(build_route_planner(self._make_topology()), GraphRoutePlanner)
        self.assertIsInstance(build_route_planner(None), EuclideanRoutePlanner)


# ---------------------------------------------------------------------------
# 4. GreedyOptimizer 排程
# ---------------------------------------------------------------------------

class SchedulingTests(unittest.TestCase):
    def test_single_task_single_resource(self):
        opt = _make_optimizer()
        ws = _make_world_state([_person("P1")], [_device("D1")])
        plan = opt.solve(ws, [_task("T1")], None, {})
        self.assertEqual(len(plan.assignments), 1)
        a = plan.assignments[0]
        self.assertEqual(a.task_id, "T1")
        self.assertEqual(a.person_id, "P1")
        self.assertEqual(a.device_id, "D1")
        self.assertEqual(plan.constraint_summary["assigned"], 1)

    def test_multi_task_multi_resource(self):
        hc = HardConstraints(station_auth={"P1": {"S1", "S2"}, "P2": {"S1", "S2"}})
        opt = _make_optimizer(constraints=hc)
        ws = _make_world_state([_person("P1"), _person("P2")], [_device("D1"), _device("D2")])
        t1 = _task("T1", station_id="S1")
        t2 = _task("T2", station_id="S2")
        plan = opt.solve(ws, [t1, t2], None, {})
        self.assertEqual(len(plan.assignments), 2)
        # 两个任务分到不同工位，且不共享同一 person/device
        self.assertNotEqual(plan.assignments[0].station_id, plan.assignments[1].station_id)

    def test_high_priority_scheduled_first(self):
        opt = _make_optimizer()
        ws = _make_world_state([_person("P1")], [_device("D1")])
        low = _task("T1", priority=1)
        high = _task("T2", priority=9)
        # 单资源，两个任务同时间窗重叠 → 高优先级先被选中，低优先级被跳过
        plan = opt.solve(ws, [low, high], None, {})
        assigned = {a.task_id for a in plan.assignments}
        self.assertIn("T2", assigned)
        self.assertNotIn("T1", assigned)

    def test_deadline_pressure_raises_priority(self):
        calc = EffectivePriorityCalculator({"deadline": 1.0, "base": 0.0})
        now = "2026-01-01T12:00:00+00:00"
        urgent = calc.compute({"task_id": "T1", "due_at": "2026-01-01T12:10:00+00:00"}, now_iso_str=now)
        relaxed = calc.compute({"task_id": "T2", "due_at": "2026-01-01T23:00:00+00:00"}, now_iso_str=now)
        self.assertGreater(urgent["deadline_pressure"], relaxed["deadline_pressure"])
        self.assertGreater(urgent["effective_priority"], relaxed["effective_priority"])

    def test_insufficient_skill_blocks_assignment(self):
        hc = HardConstraints(skills_registry={"P1": {"搬运"}})
        opt = _make_optimizer(constraints=hc)
        ws = _make_world_state([_person("P1")], [_device("D1")])
        t = _task("T1", required_skills=["焊接"])
        plan = opt.solve(ws, [t], None, {})
        self.assertEqual(len(plan.assignments), 0)
        self.assertTrue(plan.constraint_summary["violations"])

    def test_downstream_blocking(self):
        calc = EffectivePriorityCalculator({"downstream": 1.0, "base": 0.0})
        now = "2026-01-01T12:00:00+00:00"
        many = calc.compute({"task_id": "T1", "downstream_task_ids": ["a", "b", "c"]}, now_iso_str=now)
        none = calc.compute({"task_id": "T2"}, now_iso_str=now)
        self.assertGreater(many["downstream_blocking"], none["downstream_blocking"])
        self.assertGreater(many["effective_priority"], none["effective_priority"])

    def test_aging_bonus_anti_starvation(self):
        calc = EffectivePriorityCalculator({"aging": 1.0, "base": 0.0})
        now = "2026-01-01T12:00:00+00:00"
        # 等待很久的任务（earliest_start 在两小时前）aging 加成高
        old = calc.compute({"task_id": "T1", "earliest_start": "2026-01-01T10:00:00+00:00"}, now_iso_str=now)
        fresh = calc.compute({"task_id": "T2", "earliest_start": now}, now_iso_str=now)
        self.assertGreater(old["aging_bonus"], fresh["aging_bonus"])
        self.assertGreater(old["effective_priority"], fresh["effective_priority"])

    def test_time_overlap_skips_second(self):
        opt = _make_optimizer()
        ws = _make_world_state([_person("P1")], [_device("D1")])
        t1 = _task("T1", earliest_start="2026-01-01T08:00:00+00:00", estimated_duration_sec=3600)
        t2 = _task("T2", earliest_start="2026-01-01T08:30:00+00:00", estimated_duration_sec=3600)
        plan = opt.solve(ws, [t1, t2], None, {})
        assigned = {a.task_id for a in plan.assignments}
        self.assertEqual(len(assigned), 1)  # 同一 person/device 时间窗重叠，第二个被跳过


# ---------------------------------------------------------------------------
# 5. 人在回路（SchedulerService）
# ---------------------------------------------------------------------------

class HITLTests(unittest.TestCase):
    def setUp(self):
        self.svc = _make_scheduler()
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        self.plans = self.svc.generate_plans(req.request_id)
        self.plan = self.plans[0]
        self.pid = self.plan.plan_id

    def test_shadow_not_executable(self):
        self.assertEqual(self.plan.status, PLAN_SHADOW)
        with self.assertRaises(IllegalStateError):
            self.svc.execute(self.pid)

    def test_confirm_requires_reason(self):
        with self.assertRaises(ValueError):
            self.svc.confirm(self.pid, "leader1", reason="")

    def test_confirm_stale_world_state_version(self):
        with self.assertRaises(PlanStaleError):
            self.svc.confirm(self.pid, "leader1", "ok", world_state_version="WRONG-VERSION")

    def test_reject_then_not_executable(self):
        self.svc.reject(self.pid, "leader1", "驳回")
        self.assertEqual(self.svc.get_plan(self.pid).status, PLAN_ARCHIVED)
        with self.assertRaises(IllegalStateError):
            self.svc.execute(self.pid)

    def test_confirm_then_execute(self):
        confirmed = self.svc.confirm(self.pid, "leader1", "手动确认", self.plan.world_state_version)
        self.assertEqual(confirmed.status, PLAN_APPROVED)
        assignments = self.svc.execute(self.pid)
        self.assertIsInstance(assignments, list)


# ---------------------------------------------------------------------------
# 6. 重排
# ---------------------------------------------------------------------------

class ReplanTests(unittest.TestCase):
    def _candidate(self, task_id, person_id, device_id, start):
        return CandidateAssignment(
            task_id=task_id, person_id=person_id, device_id=device_id,
            station_id="S1", planned_start=start,
        )

    def _plan(self, assigns, status=PLAN_SHADOW):
        return SchedulePlan(plan_id="", assignments=assigns, status=status)

    def test_diff_unchanged_added_removed(self):
        vN = self._plan([self._candidate("T1", "P1", "D1", "2026-01-01T08:00:00+00:00")])
        vN1 = self._plan([
            self._candidate("T1", "P1", "D1", "2026-01-01T08:00:00+00:00"),
            self._candidate("T2", "P2", "D2", "2026-01-01T08:00:00+00:00"),
        ])
        r = Replanner(None).diff(vN, vN1)
        self.assertIn(("T1", "P1", "D1"), r["unchanged"])
        self.assertIn(("T2", "P2", "D2"), r["added"])

    def test_diff_reassigned(self):
        vN = self._plan([self._candidate("T1", "P1", "D1", "2026-01-01T08:00:00+00:00")])
        vN1 = self._plan([self._candidate("T1", "P2", "D2", "2026-01-01T08:00:00+00:00")])
        r = Replanner(None).diff(vN, vN1)
        self.assertEqual(r["reassigned"], ["T1"])

    def test_diff_delayed(self):
        vN = self._plan([self._candidate("T1", "P1", "D1", "2026-01-01T08:00:00+00:00")])
        vN1 = self._plan([self._candidate("T1", "P1", "D1", "2026-01-01T09:00:00+00:00")])
        r = Replanner(None).diff(vN, vN1)
        self.assertIn(("T1", "P1", "D1"), r["delayed"])

    def test_replan_preserves_frozen_assignments(self):
        world = WorldStateService()
        route = build_route_planner(None)
        opt = _make_optimizer()
        planner = Planner(optimizer=opt, route_planner=route, world_state_service=world)
        replanner = Replanner(planner)
        ws = _make_world_state([_person("P1"), _person("P2")], [_device("D1"), _device("D2")])
        tasks = [_task("T1"), _task("T2")]
        # 冻结 T1（executing）
        frozen = [Assignment(assignment_id="ASN-1", task_id="T1", status="executing")]
        new_plan = replanner.replan(ws, tasks, frozen, {"request_id": "R1"}, {"prev_version": 1})
        self.assertIsNotNone(new_plan)
        self.assertEqual(new_plan.version, 2)
        self.assertEqual(new_plan.status, PLAN_SIMULATING)
        # frozen 任务不进入新方案 active_tasks
        active_tids = {a.task_id for a in new_plan.assignments}
        self.assertNotIn("T1", active_tids)
        # frozen 分配被记录在方案上
        self.assertEqual(new_plan.frozen_assignments[0]["task_id"], "T1")

    def test_replan_device_removed(self):
        world = WorldStateService()
        route = build_route_planner(None)
        opt = _make_optimizer()
        planner = Planner(optimizer=opt, route_planner=route, world_state_service=world)
        replanner = Replanner(planner)
        # 只有一台设备，任务依赖它
        ws = _make_world_state([_person("P1")], [_device("D1")])
        tasks = [_task("T1")]
        p0 = planner.generate_top_k(ws, tasks, {"request_id": "R1"}, k=1)[0]
        self.assertGreaterEqual(len(p0.assignments), 1)
        # 设备剔除后 replan → 新方案不含该资源（无可用设备 → 无可用候选）
        ws2 = _make_world_state([_person("P1")], [], snapshot_id="WS-TEST-1111")
        new_plan = replanner.replan(ws2, tasks, [], {"request_id": "R1"}, {"prev_version": 1})
        self.assertIsNotNone(new_plan)
        assigned = [a for a in new_plan.assignments]
        self.assertEqual(len(assigned), 0)  # 资源被剔除，任务无可行解


# ---------------------------------------------------------------------------
# 7. SchedulerService 业务 API（等价于 HTTP 层，不启动 server）
# ---------------------------------------------------------------------------

class APITests(unittest.TestCase):
    def setUp(self):
        self.svc = _make_scheduler(event_bus=None)

    def test_create_task(self):
        task = self.svc.create_task(actor_id="admin", task_type="搬运", priority=5, station_id="S1")
        self.assertTrue(task.task_id)
        self.assertEqual(task.task_type, "搬运")
        self.assertEqual(task.priority, 5)

    def test_create_request_and_generate_plans(self):
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        self.assertEqual(req.status, "pending")
        self.assertIn("T1", req.task_ids)
        plans = self.svc.generate_plans(req.request_id)
        self.assertGreaterEqual(len(plans), 1)
        # get_plan
        plan = self.svc.get_plan(plans[0].plan_id)
        self.assertEqual(plan.plan_id, plans[0].plan_id)

    def test_confirm_reject_lifecycle(self):
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        plans = self.svc.generate_plans(req.request_id)
        pid = plans[0].plan_id
        # 确认成功
        confirmed = self.svc.confirm(pid, "leader1", "ok", plans[0].world_state_version)
        self.assertEqual(confirmed.status, PLAN_APPROVED)
        # 执行产生 Assignment
        assigns = self.svc.execute(pid)
        self.assertIsInstance(assigns, list)
        self.assertEqual(self.svc.get_plan(pid).status, "dispatched")

    def test_assignment_lifecycle(self):
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        plans = self.svc.generate_plans(req.request_id)
        pid = plans[0].plan_id
        self.svc.confirm(pid, "leader1", "ok", plans[0].world_state_version)
        assigns = self.svc.execute(pid)
        asn = assigns[0]
        # 沿任务状态机推进：dispatched -> received -> executing -> completed
        a = self.svc.set_assignment_status(asn.assignment_id, TASK_RECEIVED, "leader1")
        self.assertEqual(a.status, TASK_RECEIVED)
        a = self.svc.set_assignment_status(asn.assignment_id, TASK_EXECUTING, "leader1")
        self.assertEqual(a.status, TASK_EXECUTING)
        a = self.svc.set_assignment_status(asn.assignment_id, TASK_COMPLETED, "leader1")
        self.assertEqual(a.status, TASK_COMPLETED)
        # 已完成再取消 -> 非法
        with self.assertRaises(ValueError):
            self.svc.set_assignment_status(asn.assignment_id, TASK_CANCELLED, "leader1")

    def test_stale_world_state_409(self):
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        plans = self.svc.generate_plans(req.request_id)
        pid = plans[0].plan_id
        with self.assertRaises(PlanStaleError):
            self.svc.confirm(pid, "leader1", "ok", world_state_version="WRONG")
        # 错误版本已被拒绝，确认后状态仍为 shadow
        self.assertEqual(self.svc.get_plan(pid).status, PLAN_SHADOW)

    def test_replan_creates_new_plan(self):
        req = self.svc.create_request(["T1"], "manual", "A_delivery", "leader1")
        plans = self.svc.generate_plans(req.request_id)
        pid = plans[0].plan_id
        new_plan = self.svc.replan(pid, "插单", "leader1", "插单重排")
        self.assertNotEqual(new_plan.plan_id, pid)


if __name__ == "__main__":
    unittest.main()
