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
    WorldStateSnapshot,
)
from edge_platform.scheduler.repository import SchedulingRepository  # noqa: E402
from edge_platform.scheduler.scheduler_service import PlanStaleError, SchedulerService  # noqa: E402
from edge_platform.spatial import new_id  # noqa: E402
from edge_platform.stubs import Storage  # noqa: E402


class _FakeWorldState:
    """Accept stored snapshots while isolating persistence and hydration behavior."""

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

    def restore(self, reservations):
        """契约兼容（hydrate R-3 调用）；本 fake 不维护持久化预约。"""
        return 0


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
        self.repo.save_snapshot(WorldStateSnapshot(snapshot_id="WS-HYDRATE"))

    def tearDown(self):
        self.storage.close()
        self._tmpdir.cleanup()

    def _persist_plan(self):
        plan = _make_plan()
        plan.world_state_version = "WS-HYDRATE"
        self.repo.save_plan(plan)
        return plan

    def test_missing_original_snapshot_blocks_confirm_and_execute(self):
        for status, action in ((PLAN_PENDING_REVIEW, "confirm"), (PLAN_APPROVED, "execute")):
            for snapshot_id in ("", "WS-MISSING"):
                with self.subTest(action=action, snapshot_id=snapshot_id):
                    plan = _make_plan()
                    plan.status = status
                    plan.world_state_version = snapshot_id
                    self.repo.save_plan(plan)
                    service = _make_service(self.repo)
                    service.hydrate_from_repository()
                    with self.assertRaisesRegex(PlanStaleError, "原始世界快照"):
                        if action == "confirm":
                            service.confirm(plan.plan_id, "leader1", "同意")
                        else:
                            service.execute(plan.plan_id)
                    self.assertEqual(service.get_plan(plan.plan_id).status, status)
                    self.assertEqual(self.repo.get_plan(plan.plan_id)["status"], status)
                    self.assertEqual(self.repo.list_assignments(), [])
                    self.assertEqual(self.repo.list_reservations(), [])
                    self.assertEqual(self.repo.list_decisions(), [])

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

    def test_hydrate_restores_assignments_and_feedback(self):
        """R-3 回归：重启后派工可查、反馈保留（此前仅恢复 requests/plans）。"""
        from datetime import datetime, timedelta, timezone

        from edge_platform.scheduler.models import Assignment, ScheduleFeedback

        # 未来时间窗（避免预约因过期被冲突检测跳过）
        start = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds")
        end = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(timespec="seconds")
        plan = SchedulePlan(
            plan_id="PLN-HYDRATE-2",
            world_state_version="WS-HYDRATE",
            request_id="REQ-HYDRATE-2",
            version=1,
            status=PLAN_PENDING_REVIEW,
            assignments=[
                CandidateAssignment(
                    task_id="TASK-HYDRATE-2",
                    person_id="P-002",
                    device_id="EXO-002",
                    station_id="ST-002",
                    planned_start=start,
                    planned_end=end,
                )
            ],
        )
        self.repo.save_plan(plan)

        # 服务 A：execute 产生正式派工（persist 到 storage）+ 写入反馈。
        service_a = _make_service(self.repo)
        service_a.hydrate_from_repository()
        service_a.confirm(plan.plan_id, "leader1", "综合最优")
        executed = service_a.execute(plan.plan_id)
        self.assertEqual(len(executed), 1)
        service_a.feedback(plan.plan_id, {"TASK-HYDRATE-2": {"status": "completed"}})

        # 模拟进程重启：全新实例 + 全新 ReservationService（不共享内存态）。
        from edge_platform.scheduler.reservation import ReservationService

        service_b = SchedulerService(
            world_state_service=_FakeWorldState(),
            planner=_FakePlanner(),
            reservation_service=ReservationService(),
            repository=self.repo,
        )
        service_b.hydrate_from_repository()

        # 派工恢复：/api/assignments 重启后仍可查
        items = service_b.list_assignments()
        self.assertEqual(len(items), 1)
        self.assertIsInstance(items[0], Assignment)
        self.assertEqual(items[0].assignment_id, executed[0].assignment_id)
        # 状态流转可续（dispatched → received 为契约合法路径；set_assignment_status 依赖内存对象）
        a = service_b.set_assignment_status(executed[0].assignment_id, "received", "leader1", "续接执行")
        self.assertEqual(a.status, "received")

        # 反馈恢复：学习闭环数据不丢
        fbs = service_b.list_feedback()
        self.assertEqual(len(fbs), 1)
        self.assertIsInstance(fbs[0], ScheduleFeedback)
        self.assertEqual(fbs[0].plan_id, plan.plan_id)

    def test_hydrate_restores_active_reservations_and_conflict_detection(self):
        """R-3 回归：重启后 active 预约恢复，confirm 冲突检测跨重启有效（防双预约）。"""
        from datetime import datetime, timedelta, timezone

        from edge_platform.scheduler.reservation import ReservationService

        start = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds")
        end = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(timespec="seconds")
        plan = SchedulePlan(
            plan_id="PLN-HYDRATE-3",
            world_state_version="WS-HYDRATE",
            request_id="REQ-HYDRATE-3",
            version=1,
            status=PLAN_PENDING_REVIEW,
            assignments=[
                CandidateAssignment(
                    task_id="TASK-HYDRATE-3",
                    person_id="P-003",
                    device_id="EXO-003",
                    station_id="ST-003",
                    planned_start=start,
                    planned_end=end,
                )
            ],
        )
        self.repo.save_plan(plan)

        service_a = _make_service(self.repo)
        service_a.hydrate_from_repository()
        service_a.confirm(plan.plan_id, "leader1", "综合最优")
        persisted = self.repo.list_reservations(status="active")
        self.assertGreaterEqual(len(persisted), 1)
        first = persisted[0]

        # 重启：全新 ReservationService → hydrate 恢复预约 → 同窗冲突必须被检出
        svc_b_reservation = ReservationService()
        service_b = SchedulerService(
            world_state_service=_FakeWorldState(),
            planner=_FakePlanner(),
            reservation_service=svc_b_reservation,
            repository=self.repo,
        )
        service_b.hydrate_from_repository()
        self.assertTrue(
            svc_b_reservation.check_conflict(
                first["resource_id"], first["start_at"], first["end_at"]
            ),
            "重启后 active 预约必须参与冲突检测（防跨重启双预约）",
        )


if __name__ == "__main__":
    unittest.main()
