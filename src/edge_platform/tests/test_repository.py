"""智能调度持久化仓储单元测试：CRUD、乐观锁冲突、重启后数据保留。

纯 Python 标准库 unittest；用 tempfile 创建临时 sqlite 库，实例化 stubs.Storage
验证调度数据可持久化并在重新打开同一 db_path 后仍可读取。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_repository -v
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.models import (
    Reservation,
    ScheduleFeedback,
    SchedulePlan,
    ScheduleRequestMW,
    Task,
    WorldStateSnapshot,
)
from edge_platform.scheduler.repository import SchedulingRepository, VersionConflictError
from edge_platform.stubs import Storage


class SchedulingRepositoryTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "test_sched.db")
        self.storage = Storage(self.db_path)
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage)

    def tearDown(self):
        self.storage.close()
        self._tmpdir.cleanup()

    def test_save_load_task(self):
        task = Task(task_id="t-1", task_type="搬运", priority=3, status="draft")
        self.repo.save_task(task)
        got = self.repo.get_task("t-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["task_id"], "t-1")
        self.assertEqual(got["task_type"], "搬运")
        self.assertEqual(got["priority"], 3)
        # list
        self.assertEqual(len(self.repo.list_tasks()), 1)
        self.assertEqual(len(self.repo.list_tasks(status="draft")), 1)
        self.assertEqual(len(self.repo.list_tasks(status="done")), 0)

    def test_update_task_optimistic_lock_conflict(self):
        task = Task(task_id="t-2", task_type="装配")
        self.repo.save_task(task)
        # 正确版本：成功且 version 自增
        updated = self.repo.update_task("t-2", expected_version=1, status="pending_approval")
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["status"], "pending_approval")
        # 错误版本：抛 VersionConflictError
        with self.assertRaises(VersionConflictError) as cm:
            self.repo.update_task("t-2", expected_version=1, status="done")
        self.assertEqual(cm.exception.current_version, 2)
        self.assertEqual(cm.exception.expected_version, 1)

    def test_save_load_plan_with_assignments(self):
        plan = SchedulePlan(
            plan_id="pln-1",
            request_id="req-1",
            version=1,
            objective_score=0.85,
            assignments=[
                {
                    "assignment_id": "asn-p1",
                    "task_id": "t-1",
                    "person_id": "p-1",
                    "device_id": "d-1",
                    "planned_start": "2026-08-07T08:00:00+00:00",
                    "planned_end": "2026-08-07T09:00:00+00:00",
                    "score": 0.9,
                }
            ],
        )
        self.repo.save_plan(plan)
        got = self.repo.get_plan("pln-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["plan_id"], "pln-1")
        self.assertEqual(len(got["assignments"]), 1)
        self.assertEqual(got["assignments"][0]["task_id"], "t-1")
        self.assertEqual(len(self.repo.list_plans()), 1)

    def test_save_load_reservation(self):
        res = Reservation(
            reservation_id="RSV-1",
            resource_id="P-001",
            assignment_id="asn-1",
            plan_id="pln-1",
            start_at="2026-08-07T08:00:00+00:00",
            end_at="2026-08-07T09:00:00+00:00",
            status="active",
            version=1,
        )
        self.repo.save_reservation(res)
        rows = self.repo.list_reservations()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["resource_id"], "P-001")
        # 乐观锁更新预约
        updated = self.repo.update_reservation("RSV-1", expected_version=1, status="released")
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["status"], "released")
        with self.assertRaises(VersionConflictError):
            self.repo.update_reservation("RSV-1", expected_version=1, status="active")

    def test_plan_assignment_ids_are_stable_and_plan_scoped(self):
        plans = [
            SchedulePlan(plan_id=plan_id, assignments=[{"task_id": "shared-task", "person_id": plan_id}])
            for plan_id in ("plan-a", "plan-b")
        ]
        for plan in plans:
            self.repo.save_plan(plan)
        original_ids = []
        for plan in plans:
            assignments = self.repo.get_plan(plan.plan_id)["assignments"]
            self.assertEqual(len(assignments), 1)
            self.assertEqual(assignments[0]["person_id"], plan.plan_id)
            original_ids.append(assignments[0]["assignment_id"])
        self.assertEqual(len(set(original_ids)), 2)
        self.storage.close()
        self.storage = Storage(self.db_path)
        self.repo = SchedulingRepository(self.storage)
        for plan, assignment_id in zip(plans, original_ids):
            self.repo.save_plan(plan)
            self.assertEqual(self.repo.get_plan(plan.plan_id)["assignments"][0]["assignment_id"], assignment_id)
            self.assertNotIn("assignment_id", plan.assignments[0])

    def test_plan_save_replaces_removed_children_and_preserves_other_plans(self):
        plan = SchedulePlan(plan_id="replace", assignments=[{"task_id": "first"}, {"task_id": "second"}])
        other = SchedulePlan(plan_id="other", assignments=[{"task_id": "unrelated"}])
        self.repo.save_plan(plan)
        self.repo.save_plan(other)
        other_before = self.repo.get_plan(other.plan_id)
        plan.assignments = [{"task_id": "second", "person_id": "updated"}]
        plan.version = 2
        self.repo.save_plan(plan)
        stored = self.repo.get_plan(plan.plan_id)
        self.assertEqual(stored["version"], 2)
        self.assertEqual([assignment["task_id"] for assignment in stored["assignments"]], ["second"])
        self.assertEqual(stored["assignments"][0]["person_id"], "updated")
        plan.assignments = []
        self.repo.save_plan(plan)
        self.assertEqual(self.repo.get_plan(plan.plan_id)["assignments"], [])
        self.assertEqual(self.storage.get_schedule_plan(plan.plan_id)["assignments"], [])
        self.assertEqual(self.repo.get_plan(other.plan_id), other_before)

    def test_plan_child_write_failure_rolls_back_parent_and_children(self):
        plan = SchedulePlan(plan_id="atomic", assignments=[{"task_id": "original"}])
        self.repo.save_plan(plan)
        before = self.repo.get_plan(plan.plan_id)
        parent_before = self.storage.get_schedule_plan(plan.plan_id)
        with self.storage._lock, self.storage._db:
            self.storage._db.execute(
                "CREATE TRIGGER reject_plan_child BEFORE INSERT ON scheduling_plan_assignment "
                "WHEN NEW.task_id = 'fail' BEGIN SELECT RAISE(ABORT, 'injected child failure'); END"
            )
        plan.version = 2
        plan.assignments = [{"task_id": "new"}, {"task_id": "fail"}]
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected child failure"):
            self.repo.save_plan(plan)
        self.assertEqual(self.repo.get_plan(plan.plan_id), before)
        self.assertEqual(self.storage.get_schedule_plan(plan.plan_id), parent_before)
        plan.plan_id = "new-plan"
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected child failure"):
            self.repo.save_plan(plan)
        self.assertIsNone(self.repo.get_plan(plan.plan_id))
        self.assertEqual(self.storage.list_plan_assignments(plan.plan_id), [])

    def test_explicit_assignment_collision_cannot_steal_another_plan_child(self):
        original = SchedulePlan(plan_id="original", assignments=[{"assignment_id": "explicit", "task_id": "first"}])
        conflicting = SchedulePlan(plan_id="conflicting", assignments=[{"assignment_id": "explicit", "task_id": "second"}])
        self.repo.save_plan(original)
        before = self.repo.get_plan(original.plan_id)
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.save_plan(conflicting)
        self.assertEqual(self.repo.get_plan(original.plan_id), before)
        self.assertEqual(before["assignments"][0]["assignment_id"], "explicit")
        self.assertIsNone(self.repo.get_plan(conflicting.plan_id))

    def test_get_plan_reads_parent_and_children_from_one_snapshot(self):
        plan = SchedulePlan(plan_id="read-consistency", assignments=[{"task_id": "old"}])
        self.repo.save_plan(plan)
        writer_storage = Storage(self.db_path)
        writer = SchedulingRepository(writer_storage)
        decode_parent = self.storage._schedule_plan_row

        def update_after_parent_read(row):
            parent = decode_parent(row)
            plan.version = 2
            plan.assignments = [{"task_id": "new"}]
            writer.save_plan(plan)
            return parent

        try:
            with patch.object(self.storage, "_schedule_plan_row", side_effect=update_after_parent_read):
                previous = self.repo.get_plan(plan.plan_id)
            self.assertEqual(previous["version"], 1)
            self.assertEqual([assignment["task_id"] for assignment in previous["assignments"]], ["old"])
            current = self.repo.get_plan(plan.plan_id)
            self.assertEqual(current["version"], 2)
            self.assertEqual([assignment["task_id"] for assignment in current["assignments"]], ["new"])
        finally:
            writer_storage.close()

    def test_duplicate_assignment_ids_roll_back_the_plan(self):
        plan = SchedulePlan(plan_id="duplicate", assignments=[{"task_id": "original"}])
        self.repo.save_plan(plan)
        before = self.repo.get_plan(plan.plan_id)
        for assignments in (
            [{"task_id": "same-task"}, {"task_id": "same-task"}],
            [{"assignment_id": "same-id", "task_id": task_id} for task_id in ("first", "second")],
        ):
            with self.subTest(assignments=assignments):
                plan.version = 2
                plan.assignments = assignments
                with self.assertRaises(sqlite3.IntegrityError):
                    self.repo.save_plan(plan)
                self.assertEqual(self.repo.get_plan(plan.plan_id), before)

    def test_record_decision_and_feedback_and_snapshot(self):
        decision_id = self.repo.record_decision(
            "pln-1", 1, "confirm", "leader1", "综合最优", None, {"plan_id": "pln-1", "status": "approved"}
        )
        self.assertTrue(decision_id.startswith("DEC-"))
        decisions = self.repo.list_decisions(plan_id="pln-1")
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["action"], "confirm")

        fb = ScheduleFeedback(feedback_id="FB-1", plan_id="pln-1", accepted=True, actual={"ok": 1})
        self.repo.save_feedback(fb)
        fbs = self.repo.list_feedback(plan_id="pln-1")
        self.assertEqual(len(fbs), 1)
        self.assertTrue(fbs[0]["accepted"])

        snap = WorldStateSnapshot(snapshot_id="WS-1", persons=[{"person_id": "p-1"}], tasks=[{"task_id": "t-1"}])
        self.repo.save_snapshot(snap)
        got_snap = self.repo.get_snapshot("WS-1")
        self.assertIsNotNone(got_snap)
        self.assertEqual(got_snap["persons"][0]["person_id"], "p-1")
        self.assertEqual(len(self.repo.list_snapshots()), 1)

    def test_persistence_across_close_reopen(self):
        """写入数据 → 关闭并重新打开同一 db_path → 数据仍在（服务重启不丢失）。"""
        task = Task(task_id="t-restart", task_type="巡检", priority=5)
        self.repo.save_task(task)
        req = ScheduleRequestMW(request_id="req-restart", task_ids=["t-restart"], trigger_type="manual")
        self.repo.save_request(req)
        plan = SchedulePlan(plan_id="pln-restart", request_id="req-restart", status="shadow")
        self.repo.save_plan(plan)
        self.storage.close()

        storage2 = Storage(self.db_path)
        storage2.init_db()
        repo2 = SchedulingRepository(storage2)
        self.assertEqual(repo2.get_task("t-restart")["task_type"], "巡检")
        self.assertEqual(repo2.get_request("req-restart")["trigger_type"], "manual")
        self.assertEqual(repo2.get_plan("pln-restart")["status"], "shadow")
        storage2.close()


if __name__ == "__main__":
    unittest.main()
