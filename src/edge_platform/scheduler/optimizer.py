"""优化器：抽象接口 + 贪心实现（+ CP-SAT 占位）。

- GreedyOptimizer：按任务有效优先级降序，逐个任务选取硬约束通过且资源不冲突的候选，
  生成 CandidateAssignment，产出 SchedulePlan（status=shadow，version=1）。
- CpSatOptimizer：仅提供接口占位（solve 回退到 GreedyOptimizer 结果），
  供后续扩展 OR-Tools CP-SAT，绝不破坏部署。

安全纪律：本模块只产出建议/影子方案，不执行；无可行解任务记录 violation 不造假。

纯 Python 标准库实现；不依赖 OR-tools / pulp 等求解器。
"""

from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone

from edge_platform.spatial import now_iso

from .candidate import CandidateGenerator
from .constraints import HardConstraints
from .explanation import explain_candidate
from .models import (
    PLAN_SHADOW,
    CandidateAssignment,
    SchedulePlan,
)


def _parse_ts(ts, default=None):
    if not ts:
        return default
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return default
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _sub_location(item):
    if isinstance(item, dict):
        return item.get("location") or item.get("pose")
    return getattr(item, "location", None) or getattr(item, "pose", None)


class Optimizer(ABC):
    """优化器抽象基类。solve 返回 SchedulePlan（影子方案）。"""

    @abstractmethod
    def solve(self, world_state, tasks, candidates, policy):
        """求解：给定世界状态、任务集、候选、策略，返回 SchedulePlan。"""
        raise NotImplementedError


class GreedyOptimizer(Optimizer):
    """贪心求解器：任务按有效优先级降序，逐个选取资源不冲突的最优候选。"""

    def __init__(
        self,
        planner_route,
        scorer,
        effective_priority_calc,
        weights,
        constraints=None,
        generator=None,
    ):
        self.planner_route = planner_route
        self.scorer = scorer
        self.effective_priority_calc = effective_priority_calc
        self.weights = weights or {}
        self.constraints = constraints or HardConstraints()
        self.generator = generator or CandidateGenerator()

    def _rank_tasks(self, tasks):
        """按有效优先级降序排序任务。"""
        ranked = []
        for task in tasks:
            task = task or {}
            info = self.effective_priority_calc.compute(task, now_iso())
            ranked.append((task, info.get("effective_priority", 0.0)))
        ranked.sort(key=lambda t: -t[1])
        return ranked

    def _build_candidate_ctx(self, task, cand, route):
        """构造 Scorer 所需评分上下文（真实值，不虚构）。"""
        return {
            "expected_production_uplift": task.get("expected_production_uplift", 0.0),
            "on_time_probability": task.get("on_time_probability", 0.0),
            "current_load": task.get("current_load", 0.0),
            "safety_risk": task.get("safety_risk"),
            "recent_risk_events": task.get("recent_risk_events", []),
            "is_changeover": bool(task.get("is_changeover", False)),
            "distance_to_station": route.distance_m if route.reachable else None,
        }

    def _person_loc(self, person):
        """返回人员当前位置 dict（location/pose），缺省回退到 station_id。"""
        if person is None:
            return {}
        loc = _sub_location(person)
        if loc:
            return loc
        pid = person.get("person_id") if isinstance(person, dict) else getattr(person, "person_id", None)
        return {"station_id": pid} if pid else {}

    def _times_for(self, task, person_prev_end, station_prev_end):
        """推算 planned_start / planned_end（earliest_start 起，串行资源顺延）。"""
        start = _parse_ts(task.get("earliest_start"))
        if start is None:
            start = datetime.now(timezone.utc)
        if person_prev_end is not None and person_prev_end > start:
            start = person_prev_end
        if station_prev_end is not None and station_prev_end > start:
            start = station_prev_end
        duration = timedelta(seconds=int(task.get("estimated_duration_sec", 0) or 0))
        end = start + duration
        return start.isoformat(timespec="milliseconds"), end.isoformat(timespec="milliseconds")

    def solve(self, world_state, tasks, candidates, policy):
        """贪心求解。candidates 为 {task_id: [Candidate,...]}；缺省时由 generator 生成。

        从 world_state.persons 填充 HardConstraints 的技能注册表，确保真实人员技能
        参与硬约束判定（P0：此前默认空 registry 导致真实数据下技能约束恒失败）。
        """
        persons = list(getattr(world_state, "persons", []) or [])
        devices = list(getattr(world_state, "devices", []) or [])
        person_by_id = {}
        for p in persons:
            pid = p.get("person_id") if isinstance(p, dict) else getattr(p, "person_id", None)
            if pid:
                person_by_id[pid] = p

        # 若调用方未注入 skills_registry，从真实世界状态构建（P0 修复）
        if not getattr(self.constraints, "skills_registry", None):
            skills_registry = {}
            for p in persons:
                pid = p.get("person_id") if isinstance(p, dict) else getattr(p, "person_id", None)
                if not pid:
                    continue
                skills = []
                if isinstance(p, dict):
                    raw = p.get("skills", p.get("skills_json", []))
                else:
                    raw = getattr(p, "skills", None) or getattr(p, "skills_json", None) or []
                if isinstance(raw, str):
                    try:
                        import json

                        raw = json.loads(raw)
                    except (ValueError, TypeError):
                        raw = []
                if isinstance(raw, (list, tuple, set)):
                    skills = [str(s) for s in raw]
                skills_registry[pid] = set(skills)
            self.constraints.skills_registry = skills_registry

        assignments = []
        violations = []
        # 资源占用：person/device/station -> 最近结束时间
        occ = {"person": {}, "device": {}, "station": {}}

        for task, _pri in self._rank_tasks(tasks):
            task_id = task.get("task_id", "")
            cands = (candidates or {}).get(task_id)
            if cands is None:
                cands = self.generator.generate(
                    task,
                    [p for p in persons],
                    [d for d in devices],
                    self.constraints,
                    {},
                )
            passed = [c for c in cands if getattr(c, "passed", False)]
            if not passed:
                violations.append(
                    {
                        "task_id": task_id,
                        "reason": "无通过硬约束的候选",
                        "candidate_count": len(cands),
                    }
                )
                continue
            # 评分后按分数降序
            for cand in passed:
                route = self.planner_route.calculate_route(
                    self._person_loc(person_by_id.get(cand.person_id)),
                    task.get("station_id", ""),
                )
                ctx = self._build_candidate_ctx(task, cand, route)
                total, bd = self.scorer.score(cand, ctx)
                cand.score = total
                cand.score_breakdown = dict(bd)
            passed.sort(key=lambda c: c.score if c.score is not None else float("-inf"), reverse=True)

            chosen = None
            for cand in passed:
                person_prev = occ["person"].get(cand.person_id)
                device_prev = occ["device"].get(cand.device_id)
                station_prev = occ["station"].get(cand.station_id)
                # 若该资源已被占用且时间窗重叠则跳过
                if person_prev is not None or device_prev is not None or station_prev is not None:
                    p_start = _parse_ts(task.get("earliest_start")) or datetime.now(timezone.utc)
                    if (person_prev is not None and person_prev > p_start) or (
                        device_prev is not None and device_prev > p_start
                    ) or (station_prev is not None and station_prev > p_start):
                        continue
                chosen = cand
                break

            if chosen is None:
                violations.append(
                    {
                        "task_id": task_id,
                        "reason": "无可用的资源（人员/设备/工位时间冲突）",
                        "candidate_count": len(passed),
                    }
                )
                continue

            route = self.planner_route.calculate_route(
                self._person_loc(person_by_id.get(chosen.person_id)),
                task.get("station_id", ""),
            )
            planned_start, planned_end = self._times_for(
                task, occ["person"].get(chosen.person_id), occ["station"].get(chosen.station_id)
            )
            # 更新占用
            occ["person"][chosen.person_id] = _parse_ts(planned_end)
            occ["device"][chosen.device_id] = _parse_ts(planned_end)
            occ["station"][chosen.station_id] = _parse_ts(planned_end)

            expl = explain_candidate(chosen)
            assignments.append(
                CandidateAssignment(
                    task_id=task_id,
                    person_id=chosen.person_id,
                    device_id=chosen.device_id,
                    station_id=chosen.station_id,
                    route=route.to_dict(),
                    route_distance_m=route.distance_m,
                    eta_sec=route.eta_sec,
                    planned_start=planned_start,
                    planned_end=planned_end,
                    hard_constraint_results=[],
                    soft_score_breakdown=dict(chosen.score_breakdown or {}),
                    score=chosen.score or 0.0,
                    explanation=expl.to_dict() if hasattr(expl, "to_dict") else {},
                )
            )

        objective = sum(a.score for a in assignments)
        breakdown = self._aggregate_breakdown(assignments)
        return SchedulePlan(
            plan_id="",
            request_id=getattr(policy, "request_id", "") or (policy or {}).get("request_id", "")
            if isinstance(policy, dict)
            else "",
            version=1,
            assignments=assignments,
            objective_score=objective,
            objective_breakdown=breakdown,
            constraint_summary={
                "total_tasks": len(tasks),
                "assigned": len(assignments),
                "violations": violations,
            },
            world_state_version=getattr(world_state, "snapshot_id", "") or "",
            valid_until="",
            status=PLAN_SHADOW,
        )

    def _aggregate_breakdown(self, assignments):
        """汇总各 assignment 的 soft 分量（各分量求和）。"""
        keys = [
            "production_score",
            "on_time_score",
            "safety_risk",
            "body_load",
            "travel_distance",
            "changeover_cost",
        ]
        agg = {k: 0.0 for k in keys}
        for a in assignments:
            bd = a.soft_score_breakdown or {}
            for k in keys:
                v = bd.get(k)
                if v is not None:
                    try:
                        agg[k] += float(v)
                    except (TypeError, ValueError):
                        continue
        return agg


class CpSatOptimizer(Optimizer):
    """CP-SAT 优化器占位（接口）。

    docstring 说明：本类可扩展接入 OR-Tools CP-SAT（import ortools 失败时回退贪心），
    但当前实现仅返回 GreedyOptimizer 的服务结果，绝不破坏部署。
    """

    def __init__(self, greedy):
        self.greedy = greedy

    def solve(self, world_state, tasks, candidates, policy):
        """当前实现回退到贪心求解；扩展 CP-SAT 时在此替换。"""
        return self.greedy.solve(world_state, tasks, candidates, policy)
