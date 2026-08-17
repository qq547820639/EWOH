"""R2 第二轮审计整改测试：调度语义（R2-ESC-002/003/004/010）。

覆盖：
- R2-ESC-002：SchedulerService.confirm 白名单收敛到 pending_review + 统一
  validate_plan_transition（shadow→approved 契约外直转被拒绝）。
- R2-ESC-010：orchestrator.Scheduler.confirm 校验当前状态（REJECTED/EXECUTED
  终态拒绝，SHADOW/PROPOSED 可确认）。
- R2-ESC-004：ts_to_ms_safe 对坏时间戳返回 None；EventEngine 证据构建/
  聚合对坏时间戳记录按 None 防御不再崩溃。
- R2-ESC-003：GraphRoutePlanner 缺起点坐标显式 unreachable，不再伪造 (0,0)。

运行：python3 -m pytest tests/r2_sched_semantics_test.py -q
"""

import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from edge_platform.inference import ms_to_ts, ts_to_ms, ts_to_ms_safe  # noqa: E402
from edge_platform.inference.events import EventEngine  # noqa: E402
from edge_platform.scheduler import ReservationService, SchedulerService  # noqa: E402
from edge_platform.scheduler.models import (  # noqa: E402
    PLAN_APPROVED,
    PLAN_PENDING_REVIEW,
    PLAN_SHADOW,
    PLAN_SIMULATING,
    SchedulePlan,
    validate_plan_transition,
)
from edge_platform.scheduler.orchestrator import (  # noqa: E402
    CONFIRMED,
    EXECUTED,
    PROPOSED,
    REJECTED,
    SHADOW,
    Scheduler,
    ScheduleRequest,
)
from edge_platform.scheduler.route_planner import GraphRoutePlanner  # noqa: E402
from edge_platform.scheduler.scheduler_service import IllegalStateError  # noqa: E402


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ---------------------------------------------------------------------------
# R2-ESC-002：SchedulerService.confirm 走统一转移校验
# ---------------------------------------------------------------------------

class TestR2ESC002ConfirmTransition(unittest.TestCase):
    def _service_with_plan(self, status):
        svc = SchedulerService(
            world_state_service=None,
            planner=None,
            reservation_service=ReservationService(),
        )
        plan = SchedulePlan(plan_id="PLN-R2-002", request_id="REQ-1", status=status)
        svc._plans[plan.plan_id] = plan
        return svc, plan

    def test_shadow_confirm_rejected(self):
        """shadow→approved 为契约外转换，confirm 必须拒绝且状态不变。"""
        svc, plan = self._service_with_plan(PLAN_SHADOW)
        with self.assertRaises(IllegalStateError):
            svc.confirm(plan.plan_id, "leader1", "确认")
        self.assertEqual(plan.status, PLAN_SHADOW)

    def test_simulating_confirm_rejected(self):
        """simulating 也不可跳过 pending_review 直接确认。"""
        svc, plan = self._service_with_plan(PLAN_SIMULATING)
        with self.assertRaises(IllegalStateError):
            svc.confirm(plan.plan_id, "leader1", "确认")
        self.assertEqual(plan.status, PLAN_SIMULATING)

    def test_pending_review_confirm_approved(self):
        """合法路径 pending_review→approved 正常确认。"""
        svc, plan = self._service_with_plan(PLAN_PENDING_REVIEW)
        confirmed = svc.confirm(plan.plan_id, "leader1", "确认")
        self.assertEqual(confirmed.status, PLAN_APPROVED)
        self.assertEqual(confirmed.confirmed_by, "leader1")

    def test_contract_forbids_shadow_to_approved(self):
        """契约事实源：PLAN_TRANSITIONS 中 shadow 不可达 approved。"""
        with self.assertRaises(ValueError):
            validate_plan_transition(PLAN_SHADOW, PLAN_APPROVED)


# ---------------------------------------------------------------------------
# R2-ESC-010：orchestrator.Scheduler.confirm 校验当前状态
# ---------------------------------------------------------------------------

class TestR2ESC010OrchestratorConfirmState(unittest.TestCase):
    def _sched_with_request(self, status):
        sched = Scheduler(constraints=None)
        req = ScheduleRequest(
            request_id="REQ-R2-010", ts=_now_iso(), trigger={}, task={}, status=status
        )
        sched._requests[req.request_id] = req
        return sched, req

    def test_rejected_confirm_refused(self):
        """被否决的请求不可被 confirm 复活（人在回路否决权不可绕过）。"""
        sched, req = self._sched_with_request(REJECTED)
        with self.assertRaises(ValueError) as ctx:
            sched.confirm(req.request_id, "plan-1", "leader", "自动通过")
        self.assertIn("仅 SHADOW/PROPOSED 可确认", str(ctx.exception))
        self.assertEqual(req.status, REJECTED)
        self.assertEqual(req.confirmations, [])

    def test_executed_confirm_refused(self):
        """EXECUTED 终态不可回退 CONFIRMED 重复执行。"""
        sched, req = self._sched_with_request(EXECUTED)
        with self.assertRaises(ValueError):
            sched.confirm(req.request_id, "plan-1", "leader", "再次确认")
        self.assertEqual(req.status, EXECUTED)

    def test_confirmed_confirm_refused(self):
        """已 CONFIRMED 的请求不可重复确认。"""
        sched, req = self._sched_with_request(CONFIRMED)
        with self.assertRaises(ValueError):
            sched.confirm(req.request_id, "plan-1", "leader", "重复确认")
        self.assertEqual(req.status, CONFIRMED)

    def test_shadow_and_proposed_confirm_allowed(self):
        """SHADOW/PROPOSED 仍可确认（原合法路径不回归）。"""
        sched, req = self._sched_with_request(SHADOW)
        rec = sched.confirm(req.request_id, "plan-1", "leader", "确认")
        self.assertEqual(req.status, CONFIRMED)
        self.assertEqual(rec["reason"], "确认")

        sched2, req2 = self._sched_with_request(PROPOSED)
        sched2.confirm(req2.request_id, "plan-2", "leader", "确认建议")
        self.assertEqual(req2.status, CONFIRMED)


# ---------------------------------------------------------------------------
# R2-ESC-004：ts_to_ms_safe + EventEngine 坏时间戳防御
# ---------------------------------------------------------------------------

class _StubTelemetryStorage:
    """EventEngine 证据/聚合所需的最小 storage stub。"""

    def __init__(self, telemetry_rows, events):
        self._telemetry = telemetry_rows
        self._events = events

    def query_telemetry(self, device_id, start, end, limit):
        return list(self._telemetry)

    def list_events(self, limit):
        return list(self._events)


class _StubBus:
    def publish(self, *args, **kwargs):
        pass


class TestR2ESC004TsToMsSafe(unittest.TestCase):
    def test_safe_variant_returns_none_on_bad_input(self):
        for bad in (None, "", "   ", "garbage", "2026-13-45T99:99:99Z"):
            self.assertIsNone(ts_to_ms_safe(bad), f"ts_to_ms_safe({bad!r}) 应返回 None")

    def test_safe_variant_matches_strict_on_valid_input(self):
        ts = "2026-08-18T08:00:00.123+00:00"
        self.assertEqual(ts_to_ms_safe(ts), ts_to_ms(ts))

    def test_build_evidence_survives_bad_timestamp(self):
        """单条坏 timestamp 记录不得使 _build_evidence 排序/分段崩溃。"""
        now_ms = ts_to_ms(_now_iso())
        rows = [
            {"record_id": "r-early", "timestamp": ms_to_ts(now_ms - 10_000)},
            {"record_id": "r-bad-empty", "timestamp": ""},
            {"record_id": "r-bad-missing"},  # 无 timestamp 字段
            {"record_id": "r-late", "timestamp": ms_to_ts(now_ms + 10_000)},
        ]
        engine = EventEngine(_StubTelemetryStorage(rows, []), _StubBus())
        evidence = engine._build_evidence("d1", now_ms, now_ms)
        ids = {item["record_id"] for item in evidence["record_ids"]}
        # 好记录正常分段；坏记录不参与分段（无法定位窗口，不伪造归属）
        self.assertEqual(ids, {"r-early", "r-late"})
        self.assertEqual(evidence["evidence_samples"]["total"], 2)

    def test_aggregate_recent_skips_bad_start_time(self):
        """坏 start_time 的 open 事件被跳过，聚合不再崩溃。"""
        now_ms = ts_to_ms(_now_iso())
        events = [
            {"event_id": "E-bad", "event_code": "LOW_BATTERY", "severity": "L2",
             "device_id": "d1", "status": "open", "start_time": ""},
            {"event_id": "E-1", "event_code": "POSTURE_BEND_LONG", "severity": "L2",
             "device_id": "d1", "status": "open", "start_time": ms_to_ts(now_ms - 1000)},
            {"event_id": "E-2", "event_code": "DEVICE_OFFLINE", "severity": "L1",
             "device_id": "d1", "status": "open", "start_time": ms_to_ts(now_ms - 2000)},
        ]
        engine = EventEngine(_StubTelemetryStorage([], events), _StubBus())
        agg = engine.aggregate_recent("d1", now_ms)
        self.assertIsNotNone(agg)
        self.assertEqual(
            agg["aggregated_event_ids"], ["E-2", "E-1"]  # 按 start_time 升序，坏事件被排除
        )


# ---------------------------------------------------------------------------
# R2-ESC-003：GraphRoutePlanner 缺起点坐标显式 UNKNOWN/失败
# ---------------------------------------------------------------------------

class _StubTopology:
    """带坐标节点的最小拓扑 stub（TopologyNode 无坐标字段，故用 SimpleNamespace）。"""

    def __init__(self, nodes):
        self._nodes = nodes

    def nodes(self):
        return list(self._nodes)

    def shortest_path(self, a, b):
        return 10.0, [a, b]


class TestR2ESC003GraphPlannerUnknownOrigin(unittest.TestCase):
    def _planner(self):
        topo = _StubTopology([
            SimpleNamespace(node_id="N-origin", location={"x": 1.0, "y": 1.0}),
            SimpleNamespace(node_id="N-far", location={"x": 50.0, "y": 50.0}),
        ])
        return GraphRoutePlanner(topo)

    def test_missing_coordinates_resolve_to_none(self):
        """无 station_id 且无坐标的起点不得映射到 (0,0) 最近节点。"""
        planner = self._planner()
        self.assertIsNone(planner._resolve_start_node({"zone": "Z1"}))
        self.assertIsNone(planner._resolve_start_node({"x": None, "y": None}))

    def test_missing_coordinates_route_unreachable(self):
        planner = self._planner()
        route = planner.calculate_route({"zone": "Z1"}, "N-origin")
        self.assertFalse(route.reachable)
        self.assertTrue(route.blocked_reason)

    def test_valid_coordinates_still_map_nearest_node(self):
        """有坐标时最近节点映射行为不回归。"""
        planner = self._planner()
        self.assertEqual(planner._resolve_start_node({"x": 2.0, "y": 2.0}), "N-origin")
        route = planner.calculate_route({"x": 2.0, "y": 2.0}, "N-far")
        self.assertTrue(route.reachable)

    def test_station_id_direct_hit_kept(self):
        """station_id 直接命中路径保持（原有行为不回归）。"""
        planner = self._planner()
        self.assertEqual(
            planner._resolve_start_node({"station_id": "N-far"}), "N-far"
        )


if __name__ == "__main__":
    unittest.main()
