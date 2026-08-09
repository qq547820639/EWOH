"""A1 回归测试：调度服务重启后 hydrate 还原 assignments 为 CandidateAssignment 对象。

背景：hydrate_from_repository 曾把持久化的 dict 列表直接赋给 plan.assignments，
confirm()/execute() 按属性访问（planned_end/person_id/task_id/route 等）必然
AttributeError → 重启后对 approved 方案 confirm/execute 失败。

本测试覆盖验收路径：
创建 plan（pending_review）→ 持久化（repository 注入）→ 用新的 SchedulerService
实例 hydrate_from_repository() → confirm() → execute() 全链路成功，
且 assignments 还原为 CandidateAssignment 对象。

纯 Python 标准库 unittest；运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_scheduler_hydrate -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.models import (  # noqa: E402
    PLAN_APPROVED,
    PLAN_DISPATCHED,
    PLAN_PENDING_REVIEW,
    CandidateAssignment,
    Reservation,
    SchedulePlan,
)
from edge_platform.scheduler.repository import SchedulingRepository  # noqa: E402
from edge_platform.scheduler.scheduler_service import SchedulerService  # noqa: E402
from edge_platform.spatial import new_id  # noqa: E402
from edge_platform.stubs import Storage  # noqa: E402


class _FakeWorldState:
    """confirm() 的 _validate_world_state 依赖；未挂 _world_snapshot 时不会真正被调用。"""

    def build_snapshot(self, storage):
        return None

    def is_stale(self, snapshot):
        return False

    def key_changed(self, ref, current):
        return False


class _FakePlanner:
    def generate_top_k(self, snapshot, tasks, policy, k=3):
        return []


class _FakeReservationService:
    """confirm() 预约依赖：无冲突且可预约。"""

    def __init__(self):
        self.reservations = []

    def check_conflict(self, resource_id, start, end):
        return False

    def reserve(self, resource_id, assignment_id, plan_id, start, end, expires_at):
        res = Reservation(
            reservation_id=new_id("RES"),
            resource_id=resource_id,
            assignment_id=assignment_id,
            plan_id=plan_id,
            start_at=start,
            end_at=end,
            expires_at=expires_at,
        )
        self.reservations.append(res)
        return res


def _make_service(repo):
    return SchedulerService(
        world_state_service=_FakeWorldState(),
        planner=_FakePlanner(),
        reservation_service=_FakeReservationService(),
        repository=repo,
    )


def _make_plan():
    return SchedulePlan(
        plan_id="PLN-HYDRATE-1",
        request_id="REQ-HYDRATE-1",
        version=1,
        status=PLAN_PENDING_REVIEW,
        assignments=[
            CandidateAssignment(
                task_id="TASK-HYDRATE-1",
                person_id="P-001",
                device_id="EXO-001",
                station_id="ST-001",
                route={"waypoints": ["A", "B"]},
                route_distance_m=120.0,
                eta_sec=1800,
                planned_start="2026-08-07T08:00:00+00:00",
                planned_end="2026-08-07T09:00:00+00:00",
                hard_constraint_results=[{"type": "SKILL", "ok": True}],
                soft_score_breakdown={"技能匹配": 30.0},
                score=0.95,
                explanation={"note": "综合最优"},
            )
        ],
    )


class SchedulerHydrateRegressionTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "test_hydrate.db")
        self.storage = Storage(self.db_path)
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage)

    def tearDown(self):
        self.storage.close()
        self._tmpdir.cleanup()

    def _persist_plan(self):
        plan = _make_plan()
        self.repo.save_plan(plan)
        return plan

    def test_hydrate_restores_candidate_assignments_and_full_chain(self):
        """持久化 → 新实例 hydrate → confirm → execute 全链路成功。"""
        plan = self._persist_plan()

        # 模拟进程重启：全新 SchedulerService 实例，仅注入同一 repository。
        service = _make_service(self.repo)
        service.hydrate_from_repository()

        restored = service.get_plan(plan.plan_id)
        self.assertEqual(restored.status, PLAN_PENDING_REVIEW)
        self.assertEqual(len(restored.assignments), 1)
        for a in restored.assignments:
            # 关键回归点：必须是 CandidateAssignment 对象而非 dict
            self.assertIsInstance(a, CandidateAssignment)
        first = restored.assignments[0]
        self.assertEqual(first.task_id, "TASK-HYDRATE-1")
        self.assertEqual(first.person_id, "P-001")
        self.assertEqual(first.planned_start, "2026-08-07T08:00:00+00:00")
        self.assertEqual(first.planned_end, "2026-08-07T09:00:00+00:00")
        self.assertEqual(first.route, {"waypoints": ["A", "B"]})
        self.assertAlmostEqual(first.score, 0.95)

        # confirm：按属性访问 planned_end/person_id/planned_start（旧实现在此 AttributeError）
        confirmed = service.confirm(plan.plan_id, "leader1", "综合最优")
        self.assertEqual(confirmed.status, PLAN_APPROVED)
        self.assertEqual(confirmed.confirmed_by, "leader1")

        # execute：按属性访问 ca.task_id/route/person_id/device_id/station_id
        assignments = service.execute(plan.plan_id)
        self.assertEqual(len(assignments), 1)
        self.assertEqual(assignments[0].task_id, "TASK-HYDRATE-1")
        self.assertEqual(assignments[0].person_id, "P-001")
        self.assertEqual(assignments[0].device_id, "EXO-001")
        self.assertEqual(assignments[0].station_id, "ST-001")
        self.assertEqual(assignments[0].route, {"waypoints": ["A", "B"]})
        self.assertEqual(service.get_plan(plan.plan_id).status, PLAN_DISPATCHED)
        # 预约已落库
        self.assertGreaterEqual(len(self.repo.list_reservations()), 1)

    def test_hydrate_skips_corrupt_plan_without_breaking_others(self):
        """单条损坏方案（缺必填字段）被跳过并记日志，不影响其余方案恢复。"""
        good = _make_plan()
        self.repo.save_plan(good)
        # 直接以 dict 持久化坏数据（模拟遗留/损坏行）：assignment 缺 task_id →
        # hydrate 时 CandidateAssignment 构造失败 → 跳过并记日志。
        bad = {
            "plan_id": "PLN-BAD",
            "request_id": "REQ-BAD",
            "version": 1,
            "status": PLAN_PENDING_REVIEW,
            "assignments": [{"person_id": "P-X", "planned_start": "2026-08-07T08:00:00+00:00"}],
        }
        self.repo.save_plan(bad)

        service = _make_service(self.repo)
        service.hydrate_from_repository()

        self.assertIsNotNone(service.get_plan(good.plan_id))
        with self.assertRaises(KeyError):
            service.get_plan("PLN-BAD")


if __name__ == "__main__":
    unittest.main()
