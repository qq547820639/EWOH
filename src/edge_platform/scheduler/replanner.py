"""局部重调度：在保留已执行/锁定分配的前提下生成新版本方案，并输出差异。

- replan：冻结 frozen_assignments（executing/locked）不参与重排，其余任务重新规划，
  产出 version+1 的新方案。
- diff：按 (task_id, person_id, device_id) 与 planned_start 比较两版方案差异。

纯 Python 标准库实现。
"""

from .models import PLAN_SIMULATING


def _assign_key(a):
    """方案内单条排程标识：(task_id, person_id, device_id)。"""
    return (
        getattr(a, "task_id", a.get("task_id", "") if isinstance(a, dict) else ""),
        getattr(a, "person_id", a.get("person_id", "") if isinstance(a, dict) else ""),
        getattr(a, "device_id", a.get("device_id", "") if isinstance(a, dict) else ""),
    )


def _planned_start(a):
    return getattr(a, "planned_start", a.get("planned_start", "") if isinstance(a, dict) else "")


def _task_id(a):
    return getattr(a, "task_id", a.get("task_id", "") if isinstance(a, dict) else "")


class Replanner:
    """局部重调度器。"""

    def __init__(self, planner):
        self.planner = planner

    def replan(self, world_state, tasks, frozen_assignments, policy, changes_gate):
        """生成新版本方案（version+1），冻结分配不参与重排。

        frozen_assignments 中的任务从重排范围剔除；changes_gate 可携带
        {"prev_version": int} 用于续版。
        """
        frozen_ids = {_task_id(a) for a in (frozen_assignments or [])}
        active_tasks = [t for t in (tasks or []) if (t or {}).get("task_id") not in frozen_ids]
        plans = self.planner.generate_top_k(world_state, active_tasks, policy, k=1)
        if not plans:
            return None
        plan = plans[0]
        gate = changes_gate if isinstance(changes_gate, dict) else {}
        prev_version = int(gate.get("prev_version", 1) or 1)
        plan.version = prev_version + 1
        plan.status = PLAN_SIMULATING
        plan.frozen_assignments = [
            a.to_dict() if hasattr(a, "to_dict") else dict(a)
            for a in (frozen_assignments or [])
        ]
        return plan

    def diff(self, plan_vN, plan_vN1):
        """比较两版方案差异，返回 {unchanged, added, removed, reassigned, delayed}。

        比较维度：(task_id, person_id, device_id) 与 planned_start。
        """
        result = {"unchanged": [], "added": [], "removed": [], "reassigned": [], "delayed": []}
        old = {_assign_key(a): a for a in (plan_vN.assignments or [])}
        new = {_assign_key(a): a for a in (plan_vN1.assignments or [])}

        for key, a_new in new.items():
            if key not in old:
                result["added"].append(key)
                continue
            a_old = old[key]
            if _planned_start(a_old) == _planned_start(a_new):
                result["unchanged"].append(key)
            elif _planned_start(a_new) > _planned_start(a_old):
                result["delayed"].append(key)
            else:
                result["unchanged"].append(key)

        for key in old:
            if key not in new:
                result["removed"].append(key)

        # 同一 task_id 换了资源 → reassigned
        old_by_task = {_task_id(a): _assign_key(a) for a in (plan_vN.assignments or [])}
        new_by_task = {_task_id(a): _assign_key(a) for a in (plan_vN1.assignments or [])}
        for tid in set(old_by_task) & set(new_by_task):
            if old_by_task[tid] != new_by_task[tid]:
                result["reassigned"].append(tid)

        return result
