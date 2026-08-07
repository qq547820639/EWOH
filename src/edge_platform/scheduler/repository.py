"""智能调度持久化适配层：Scheduler 与 Storage 之间的 CRUD 封装 + 乐观锁版本冲突检测。

本模块作为 SchedulerService 与持久层（stubs.Storage / 真实 edge.storage）之间的适配层：
- 统一把调度各数据模型（Task / ScheduleRequestMW / SchedulePlan / Assignment /
  Reservation / ScheduleFeedback / WorldStateSnapshot）序列化为 dict 后交给 Storage；
- 提供乐观锁 version 冲突检测：update_task / update_reservation 在版本不匹配时抛
  VersionConflictError，避免服务重启或并发写入时基于过期版本覆盖。

纯 Python 标准库实现。
"""

from edge_platform.spatial import new_id


class VersionConflictError(Exception):
    """乐观锁版本冲突：写入时的 expected_version 与当前持久化版本不一致。"""

    def __init__(self, current_version, expected_version, message=None):
        self.current_version = current_version
        self.expected_version = expected_version
        super().__init__(
            message
            or f"版本冲突: 当前版本 {current_version} != 期望版本 {expected_version}"
        )


def _to_dict(obj):
    """对象 → dict：优先调用 to_dict()，dict 原样返回，否则按 dict 处理。"""
    if isinstance(obj, dict):
        return obj
    to_dict = getattr(obj, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return dict(obj)


class SchedulingRepository:
    """调度持久化仓储：封装 Storage 的调度 CRUD，并实现乐观锁。"""

    def __init__(self, storage):
        """保存 storage 引用（stubs.Storage 或真实 edge.storage）。"""
        self.storage = storage

    # ---- 通用对象→dict ----

    @staticmethod
    def _as_dict(obj):
        return _to_dict(obj)

    # ---- 任务 ----

    def save_task(self, task):
        """保存任务（Task 对象或 dict），返回保存后的 dict。"""
        d = dict(self._as_dict(task))
        return self.storage.upsert_task(d.pop("task_id"), **d)

    def get_task(self, task_id):
        """按 task_id 取任务，返回 dict；不存在返回 None。"""
        return self.storage.get_task(task_id)

    def list_tasks(self, status=None):
        """列出任务（可选按 status 过滤），返回 dict 列表。"""
        return self.storage.list_tasks(status=status)

    # ---- 调度请求 ----

    def save_request(self, req):
        """保存调度请求（ScheduleRequestMW 对象或 dict），返回 dict。"""
        d = dict(self._as_dict(req))
        return self.storage.upsert_scheduling_request(d.pop("request_id"), **d)

    def get_request(self, request_id):
        """按 request_id 取调度请求，返回 dict；不存在返回 None。"""
        return self.storage.get_scheduling_request(request_id)

    def list_requests(self, status=None):
        """列出调度请求（可选按 status 过滤），返回 dict 列表。"""
        return self.storage.list_scheduling_requests(status=status)

    # ---- 方案 ----

    def save_plan(self, plan):
        """保存方案（SchedulePlan 对象或 dict）：先存方案主表，再逐条存 assignments。"""
        d = dict(self._as_dict(plan))
        plan_id = d.pop("plan_id")
        self.storage.save_schedule_plan(plan_id, **d)
        assignments = d.get("assignments") or []
        for assign in assignments:
            self.storage.save_plan_assignment(plan_id, self._as_dict(assign))
        return d

    def get_plan(self, plan_id):
        """按 plan_id 取方案：基础信息 + 补全 assignments，返回 dict。"""
        d = self.storage.get_schedule_plan(plan_id)
        if d is None:
            return None
        d["assignments"] = self.storage.list_plan_assignments(plan_id)
        return d

    def list_plans(self, status=None):
        """列出方案（可选按 status 过滤），返回 dict 列表。"""
        return self.storage.list_schedule_plans(status=status)

    # ---- 预约 ----

    def save_reservation(self, res):
        """保存预约（Reservation 对象或 dict）。"""
        d = dict(self._as_dict(res))
        self.storage.upsert_reservation(d.pop("reservation_id"), **d)
        return d

    def list_reservations(self, status=None):
        """列出预约（可选按 status 过滤），返回 dict 列表。"""
        return self.storage.list_reservations(status=status)

    # ---- 决策 / 审计 ----

    def record_decision(self, plan_id, version, action, actor_id, reason, before, after):
        """记录一次调度决策（approve/reject/confirm 等），返回 decision_id。"""
        decision_id = new_id("DEC")
        self.storage.insert_schedule_decision(
            decision_id, plan_id, version, action, actor_id, reason, before, after
        )
        return decision_id

    def list_decisions(self, plan_id=None):
        """列出调度决策（可选按 plan_id 过滤），返回 dict 列表。"""
        return self.storage.list_schedule_decisions(plan_id=plan_id)

    # ---- 反馈 ----

    def save_feedback(self, fb):
        """保存执行反馈（ScheduleFeedback 对象或 dict）。"""
        d = dict(self._as_dict(fb))
        self.storage.upsert_schedule_feedback(d.pop("feedback_id"), **d)
        return d

    def list_feedback(self, plan_id=None):
        """列出执行反馈（可选按 plan_id 过滤），返回 dict 列表。"""
        return self.storage.list_schedule_feedback(plan_id=plan_id)

    # ---- 快照 ----

    def save_snapshot(self, snap):
        """保存世界状态快照（WorldStateSnapshot 对象或 dict）。"""
        d = dict(self._as_dict(snap))
        self.storage.save_world_state_snapshot(d.pop("snapshot_id"), **d)
        return d

    def get_snapshot(self, snapshot_id):
        """按 snapshot_id 取快照，返回 dict；不存在返回 None。"""
        return self.storage.get_world_state_snapshot(snapshot_id)

    def list_snapshots(self, limit=20):
        """列出最近的世界状态快照（默认 20），返回 dict 列表。"""
        return self.storage.list_world_state_snapshots(limit=limit)

    # ---- 派工分配（正式 Assignment 落库到旧 assignment 表） ----

    def save_assignment(self, assignment):
        """保存正式派工记录（Assignment 对象或 dict），返回最新记录 dict。"""
        d = self._as_dict(assignment)
        return self.storage.upsert_assignment(
            assignment_id=d["assignment_id"],
            task_id=d.get("task_id"),
            person_id=d.get("person_id"),
            device_id=d.get("device_id"),
            status=d.get("status", "proposed"),
            plan_id=d.get("plan_id"),
            station_id=d.get("station_id"),
            route=d.get("route"),
            planned_start=d.get("planned_start"),
            planned_end=d.get("planned_end"),
            actual_start=d.get("actual_start"),
            actual_end=d.get("actual_end"),
            version=d.get("version"),
        )

    # ---- 乐观锁 ----

    def update_task(self, task_id, expected_version, **fields):
        """乐观锁更新任务：版本不匹配抛 VersionConflictError。

        匹配则把 version 自增并合并 fields 后 upsert，返回保存后的 dict。
        """
        current = self.storage.get_task(task_id)
        current_version = int(current["version"]) if current else 0
        if current is None or current_version != int(expected_version):
            raise VersionConflictError(current_version, int(expected_version))
        merged = dict(current)
        merged.update(fields)
        merged["version"] = current_version + 1
        merged.pop("task_id", None)
        return self.storage.upsert_task(task_id, **merged)

    def update_reservation(self, reservation_id, expected_version, **fields):
        """乐观锁更新预约：版本不匹配抛 VersionConflictError。

        匹配则把 version 自增并合并 fields 后 upsert。
        """
        current = self._get_reservation_raw(reservation_id)
        current_version = int(current["version"]) if current else 0
        if current is None or current_version != int(expected_version):
            raise VersionConflictError(current_version, int(expected_version))
        merged = dict(current)
        merged.update(fields)
        merged["version"] = current_version + 1
        merged.pop("reservation_id", None)
        self.storage.upsert_reservation(reservation_id, **merged)
        return merged

    def _get_reservation_raw(self, reservation_id):
        """从 Storage 直接读预约原始行（list_reservations 无按 id 查询，做一次全表匹配）。"""
        for r in self.storage.list_reservations():
            if r.get("reservation_id") == reservation_id:
                return r
        return None
