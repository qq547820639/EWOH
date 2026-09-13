"""任务↔派工状态机同步测试（ADR-029 / R-3 收口，§3 任务事实单一化）。

覆盖：
- execute() 派工落账后推进 Task（pending_dispatch → dispatched）；
- set_assignment_status 推进派工 → Task 同步（既有行为回归）；
- update_task 推进任务 → 其派工同状态机收敛（新增，含最短合法链补全）；
- 任务缺失（legacy 方案）→ execute 不炸、显式跳过；
- 已一致状态 → 幂等跳过（不重复版本自增）；
- 派工已终态无法跟随 → 显式跳过不拉回。

纯 Python 标准库 unittest；运行：
PYTHONPATH=src python -m unittest edge_platform.tests.test_task_assignment_sync -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.models import (  # noqa: E402
    PLAN_PENDING_REVIEW,
    TASK_COMPLETED,
    TASK_DISPATCHED,
    TASK_EXECUTING,
    TASK_PENDING_DISPATCH,
    CandidateAssignment,
    Reservation,
    SchedulePlan,
    WorldStateSnapshot,
)
from edge_platform.scheduler.repository import SchedulingRepository  # noqa: E402
from edge_platform.scheduler.scheduler_service import SchedulerService  # noqa: E402
from edge_platform.spatial import new_id  # noqa: E402
from edge_platform.stubs import Storage  # noqa: E402


class _FakeWorldState:
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
        return 0


def _make_service(repo):
    return SchedulerService(
        world_state_service=_FakeWorldState(),
        planner=_FakePlanner(),
        reservation_service=_FakeReservationService(),
        repository=repo,
    )


def _make_plan(task_id="TASK-SYNC-1", plan_id="PLN-SYNC-1"):
    return SchedulePlan(
        plan_id=plan_id,
        request_id="REQ-SYNC-1",
        version=1,
        status=PLAN_PENDING_REVIEW,
        assignments=[
            CandidateAssignment(
                task_id=task_id,
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


class TaskAssignmentSyncTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "test_sync.db")
        self.storage = Storage(self.db_path)
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage)
        self.service = _make_service(self.repo)

    def tearDown(self):
        self.storage.close()
        self._tmpdir.cleanup()

    def _create_task(self, task_id="TASK-SYNC-1", status=TASK_PENDING_DISPATCH):
        return self.service.create_task(
            "tester",
            task_id=task_id,
            task_type="搬运",
            priority=5,
            status=status,
        )

    def _approve_and_execute(self, plan):
        snapshot = WorldStateSnapshot(snapshot_id="WS-SYNC")
        plan.world_state_version = snapshot.snapshot_id
        self.repo.save_snapshot(snapshot)
        self.repo.save_plan(plan)
        self.service.hydrate_from_repository()
        self.service.confirm(plan.plan_id, "leader1", "同意")
        return self.service.execute(plan.plan_id)

    def test_execute_syncs_task_to_dispatched(self):
        """R-3 主修复：execute 后 Task pending_dispatch → dispatched（单一事实）。"""
        self._create_task()
        plan = _make_plan()
        assignments = self._approve_and_execute(plan)
        self.assertEqual(len(assignments), 1)
        task = self.service.get_task("TASK-SYNC-1")
        self.assertEqual(task.get("status"), TASK_DISPATCHED)

    def test_execute_with_missing_task_skips_without_crash(self):
        """legacy 方案引用不存在的任务：派工照常落账，任务同步显式跳过。"""
        plan = _make_plan(task_id="TASK-GHOST")
        assignments = self._approve_and_execute(plan)
        self.assertEqual(len(assignments), 1)
        self.assertEqual(assignments[0].status, TASK_DISPATCHED)

    def test_execute_idempotent_when_task_already_dispatched(self):
        """任务已 dispatched（重复执行场景）：不重复版本自增。"""
        self._create_task(status=TASK_DISPATCHED)
        version_before = int(self.service.get_task("TASK-SYNC-1").get("version") or 1)
        self._approve_and_execute(_make_plan())
        task = self.service.get_task("TASK-SYNC-1")
        self.assertEqual(task.get("status"), TASK_DISPATCHED)
        self.assertEqual(int(task.get("version") or 1), version_before)

    def test_set_assignment_status_syncs_task(self):
        """派工推进（dispatched→executing 最短链）→ Task 同步 executing。"""
        self._create_task()
        assignments = self._approve_and_execute(_make_plan())
        a = self.service.set_assignment_status(
            assignments[0].assignment_id, TASK_EXECUTING, "tester", "开工"
        )
        self.assertEqual(a.status, TASK_EXECUTING)
        self.assertEqual(self.service.get_task("TASK-SYNC-1").get("status"), TASK_EXECUTING)

    def test_update_task_syncs_assignments(self):
        """ADR-029 决策 3：任务 API 推进 completed → 其派工沿最短链收敛。"""
        self._create_task()
        assignments = self._approve_and_execute(_make_plan())
        self.service.update_task("TASK-SYNC-1", "tester", status=TASK_COMPLETED)
        updated = self.service.get_assignment(assignments[0].assignment_id)
        self.assertEqual(updated.status, TASK_COMPLETED)
        # EDT-001：原 assertEqual(x, x) 恒真——改为真实非空校验（completed 落实际结束时间）
        self.assertIsNotNone(updated.actual_end, "completed 派工应记录实际结束时间")

    def test_update_task_repeat_completed_keeps_consistency(self):
        """任务与其派工均已 completed：重复推进不破坏一致性（状态不变，
        version 按乐观锁语义自增；派工不被重复推进）。"""
        self._create_task()
        assignments = self._approve_and_execute(_make_plan())
        self.service.set_assignment_status(
            assignments[0].assignment_id, TASK_COMPLETED, "tester", "完成"
        )
        version_before = int(self.service.get_task("TASK-SYNC-1").get("version") or 1)
        self.service.update_task("TASK-SYNC-1", "tester", status=TASK_COMPLETED)
        task = self.service.get_task("TASK-SYNC-1")
        self.assertEqual(task.get("status"), TASK_COMPLETED)
        self.assertEqual(int(task.get("version") or 1), version_before + 1)
        a = self.service.get_assignment(assignments[0].assignment_id)
        self.assertEqual(a.status, TASK_COMPLETED)

    def test_confirmed_then_execute_plan_state_and_task_consistent(self):
        """端到端：任务+方案+派工三者状态一致（§3 无分叉）。"""
        task = self._create_task()
        self.assertEqual(task.status, TASK_PENDING_DISPATCH)
        plan = _make_plan()
        assignments = self._approve_and_execute(plan)
        self.assertEqual(self.service.get_plan(plan.plan_id).status, "dispatched")
        self.assertEqual(self.service.get_task("TASK-SYNC-1").get("status"), TASK_DISPATCHED)
        self.assertEqual(assignments[0].status, TASK_DISPATCHED)


if __name__ == "__main__":
    unittest.main()
