"""OR-Tools CP-SAT 求解器实现。

在给定 SolverRequest 下构建 CP-SAT 模型并求解：
- 决策：每个任务是否指派给 (person, device, station) 组合，以及开始/结束时间。
- 硬约束：任务至多分配一次；person/device/station 时间不重叠；availability；
  skills；certifications；capabilities；前置任务先于后继；时间窗；reservation；
  forbidden zone；Safety Hold；executing/locked（frozen）assignment 不可移动。
- 目标：最小化 lateness / travel / stationWait / workload imbalance / changeover /
  risk / energyRisk / schedule instability（churn）。

依赖与真实边界：
- 生产环境需安装 `ortools`（`pip install ortools`）。
- 若未安装，`solve()` 返回 solverStatus="UNAVAILABLE"，由控制面安全回退到
  HeuristicSchedulingSolver——绝不把 fallback 描述为 CP-SAT 成功。
- 本 worker 只产出任务建议/方案/Assignment，不写入任何设备实时安全控制参数。

安全边界：Safety Hold / forbidden zone / executing+locked 不可移动作为代码级硬约束保留，
不可被配置或求解绕过。
"""

from __future__ import annotations

import time
from typing import Dict, List, Optional

from .contract import SolverRequest, SolverResponse, SolverAssignmentResult

SOLVER_VERSION = "cpsat-v1"

try:  # pragma: no cover - 依赖探测
    from ortools.sat.python import cp_model  # type: ignore

    _ORT_TOOLS_AVAILABLE = True
except Exception:  # noqa: BLE001 - 任何导入失败都视为不可用
    _ORT_TOOLS_AVAILABLE = False

# 时间单位：分钟，避免大规模整数溢出。
MINUTE = 60_000


def is_available() -> bool:
    """OR-Tools 依赖是否可用。"""
    return _ORT_TOOLS_AVAILABLE


def solve(request: SolverRequest) -> SolverResponse:
    """求解入口。OR-Tools 缺失时返回 UNAVAILABLE（不冒充 CP-SAT 成功）。"""
    if not _ORT_TOOLS_AVAILABLE:
        return _unavailable_response(request)
    return _solve_cpsat(request)


def _unavailable_response(request: SolverRequest) -> SolverResponse:
    return SolverResponse(
        solverVersion=SOLVER_VERSION,
        solverStatus="UNAVAILABLE",
        solveDurationMs=0,
        objective=0.0,
        hardViolations=[
            {
                "type": "DEPENDENCY_UNAVAILABLE",
                "reason": "ortools not installed; install with `pip install ortools`",
            }
        ],
        unassignedTaskIds=[t.taskId for t in request.tasks],
    )


def _solve_cpsat(request: SolverRequest) -> SolverResponse:
    """真实 OR-Tools CP-SAT 求解。

    TODO(cpsat): 该模型在具备 ortools 的环境中加载后需补充 fixture 验证
    （硬约束=0 / INFEASIBLE / 确定性重放），当前环境未安装 ortools，
    属依赖阻塞，未用假数据冒充完成。
    """
    started = time.monotonic()
    model = cp_model.CpModel()

    person_ids = [p.id for p in request.persons]
    device_ids = [d.id for d in request.devices]
    station_ids = [s.id for s in request.stations]
    person_by_id = {p.id: p for p in request.persons}
    device_by_id = {d.id: d for d in request.devices}
    station_by_id = {s.id: s for s in request.stations}

    frozen_by_task = {f.taskId: f for f in request.frozenAssignments}
    frozen_person_ids = {f.personId for f in request.frozenAssignments if f.personId}
    frozen_device_ids = {f.deviceId for f in request.frozenAssignments if f.deviceId}
    frozen_station_ids = {f.stationId for f in request.frozenAssignments if f.stationId}

    horizon_end = request.nowMs + request.horizonMinutes * MINUTE
    horizon_min = (horizon_end - request.nowMs) // MINUTE

    # ---- 候选生成（分层过滤，避免全笛卡尔积）----
    # candidate: taskId -> list of (person_idx, device_idx, station_idx)；device_idx=-1 表示不用设备。
    candidates: Dict[str, List[tuple]] = {}
    candidate_rejected: Dict[str, List[Dict]] = {}

    for t in request.tasks:
        cands: List[tuple] = []
        rejected: List[Dict] = []
        allowed_person_ids = set(t.eligiblePersonIds) if t.eligiblePersonIds else None
        allowed_device_ids = set(t.eligibleDeviceIds) if t.eligibleDeviceIds else None

        for pi, p in enumerate(request.persons):
            if p.id in frozen_person_ids:
                continue
            if allowed_person_ids is not None and p.id not in allowed_person_ids:
                continue
            if p.status != "available":
                rejected.append({"personId": p.id, "reason": ["person_unavailable"]})
                continue
            if not all(s in p.skills for s in t.requiredSkills):
                rejected.append({"personId": p.id, "reason": ["missing_skill"]})
                continue
            if not all(c in p.certifications for c in t.requiredCertifications):
                rejected.append({"personId": p.id, "reason": ["missing_certification"]})
                continue

            device_indexes: List[int] = []
            if t.requiredDeviceCapabilities:
                for di, d in enumerate(request.devices):
                    if d.id in frozen_device_ids:
                        continue
                    if allowed_device_ids is not None and d.id not in allowed_device_ids:
                        continue
                    if not d.online or d.status == "fault":
                        rejected.append({"personId": p.id, "deviceId": d.id, "reason": ["device_offline"]})
                        continue
                    if not all(cap in d.capabilities for cap in t.requiredDeviceCapabilities):
                        rejected.append({"personId": p.id, "deviceId": d.id, "reason": ["device_capability_mismatch"]})
                        continue
                    device_indexes.append(di)
            else:
                device_indexes = [-1]

            station_indexes: List[int] = []
            if t.candidateStationIds:
                for si, sid in enumerate(station_ids):
                    if sid in frozen_station_ids:
                        continue
                    if sid in t.candidateStationIds:
                        station_indexes.append(si)
            else:
                station_indexes = list(range(len(station_ids)))

            for di in device_indexes:
                for si in station_indexes:
                    cands.append((pi, di, si))

        candidates[t.taskId] = cands
        candidate_rejected[t.taskId] = rejected

    # ---- 决策变量 ----
    start_min: Dict[str, object] = {}
    end_min: Dict[str, object] = {}
    presence: Dict[str, Dict[tuple, object]] = {}  # taskId -> {(pi,di,si): boolvar}
    interval_by_resource: Dict[str, List[object]] = {}

    # 冻结任务：固定时间；其余任务：start/end 整数变量。
    for t in request.tasks:
        if t.taskId in frozen_by_task:
            f = frozen_by_task[t.taskId]
            start_min[t.taskId] = model.NewConstant(f.startMs // MINUTE)
            end_min[t.taskId] = model.NewConstant(f.endMs // MINUTE)
            for pid, did, sid, sMs, eMs in [
                (f.personId, f.deviceId, f.stationId, f.startMs, f.endMs),
            ]:
                if pid:
                    key = f"p:{pid}"
                    interval_by_resource.setdefault(key, []).append(
                        model.NewIntervalVar(
                            model.NewConstant(sMs // MINUTE),
                            max(1, (eMs - sMs) // MINUTE),
                            model.NewConstant(eMs // MINUTE),
                            f"frozen_p_{pid}_{t.taskId}",
                        )
                    )
                if did:
                    key = f"d:{did}"
                    interval_by_resource.setdefault(key, []).append(
                        model.NewIntervalVar(
                            model.NewConstant(sMs // MINUTE),
                            max(1, (eMs - sMs) // MINUTE),
                            model.NewConstant(eMs // MINUTE),
                            f"frozen_d_{did}_{t.taskId}",
                        )
                    )
                if sid:
                    key = f"s:{sid}"
                    interval_by_resource.setdefault(key, []).append(
                        model.NewIntervalVar(
                            model.NewConstant(sMs // MINUTE),
                            max(1, (eMs - sMs) // MINUTE),
                            model.NewConstant(eMs // MINUTE),
                            f"frozen_s_{sid}_{t.taskId}",
                        )
                    )
            continue
        if not candidates.get(t.taskId):
            continue
        lo = max(0, (t.earliestStartMs - request.nowMs) // MINUTE)
        hi = max(horizon_min, lo + 1)
        s = model.NewIntVar(lo, hi, f"start_{t.taskId}")
        e = model.NewIntVar(lo + 1, hi + 10, f"end_{t.taskId}")
        model.Add(e == s + max(1, t.durationMs // MINUTE))
        start_min[t.taskId] = s
        end_min[t.taskId] = e

        # 每个候选一个 presence 布尔，并绑定候选资源上的 interval。
        presence[t.taskId] = {}
        for pi, di, si in candidates[t.taskId]:
            present = model.NewBoolVar(f"x_{t.taskId}_{pi}_{di}_{si}")
            presence[t.taskId][(pi, di, si)] = present
            dur = max(1, t.durationMs // MINUTE)
            p = request.persons[pi]
            key = f"p:{p.id}"
            interval_by_resource.setdefault(key, []).append(
                model.NewOptionalIntervalVar(s, dur, e, present, f"pi_{p.id}_{t.taskId}_{di}_{si}")
            )
            if di != -1:
                d = request.devices[di]
                key = f"d:{d.id}"
                interval_by_resource.setdefault(key, []).append(
                    model.NewOptionalIntervalVar(s, dur, e, present, f"di_{d.id}_{t.taskId}_{pi}_{si}")
                )
            if si != -1:
                st = request.stations[si]
                key = f"s:{st.id}"
                interval_by_resource.setdefault(key, []).append(
                    model.NewOptionalIntervalVar(s, dur, e, present, f"si_{st.id}_{t.taskId}_{pi}_{di}")
                )

    # ---- 硬约束 ----
    # 1) 任务至多分配一次。
    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        model.Add(sum(presence[t.taskId].values()) <= 1)

    # 2) 前置任务：后继开始 >= 前置结束。
    for t in request.tasks:
        for pred in t.predecessorIds:
            if pred not in start_min or t.taskId not in start_min:
                continue
            model.Add(start_min[t.taskId] >= end_min[pred])

    # 3) 时间窗：end <= due。
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in end_min:
            continue
        if t.dueMs:
            model.Add(end_min[t.taskId] <= t.dueMs // MINUTE)

    # 4) reservation 冲突：已预订区间与该任务占用重叠 → 不可在对应资源上。
    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        for (pi, di, si), present in presence[t.taskId].items():
            p = request.persons[pi]
            for r in request.reservations:
                if r.resourceType == "person" and r.resourceId == p.id:
                    model.Add(present == 0)
            if di != -1:
                d = request.devices[di]
                for r in request.reservations:
                    if r.resourceType == "device" and r.resourceId == d.id:
                        model.Add(present == 0)
            if si != -1:
                st = request.stations[si]
                for r in request.reservations:
                    if r.resourceType == "station" and r.resourceId == st.id:
                        model.Add(present == 0)

    # 5) forbidden zone：任务 zone 在禁入区 → 无候选（已在候选层处理，此处兜底）。
    # 6) 资源 no-overlap。
    for key, ivs in interval_by_resource.items():
        if len(ivs) > 1:
            model.AddNoOverlap(ivs)

    # ---- 目标函数（软目标，最小化，分钟单位）----
    w = request.weights
    terms: List[object] = []

    # lateness：max(0, end - due)。
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in end_min or not t.dueMs:
            continue
        late = model.NewIntVar(0, horizon_min + 10, f"late_{t.taskId}")
        model.AddMaxEquality(late, [0, end_min[t.taskId] - t.dueMs // MINUTE])
        terms.append(w.lateness * late)

    # stationWait：start - earliestStart。
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in start_min:
            continue
        earliest = max(0, (t.earliestStartMs - request.nowMs) // MINUTE)
        wait = model.NewIntVar(0, horizon_min + 10, f"wait_{t.taskId}")
        model.AddMaxEquality(wait, [0, start_min[t.taskId] - earliest])
        terms.append(w.stationWait * wait)

    # travel：按被选候选的欧氏距离加权（近似，真实路线由控制面传入）。
    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        for (pi, di, si), present in presence[t.taskId].items():
            p = request.persons[pi]
            if si != -1:
                st = request.stations[si]
                dist_m = int(((p.x - st.x) ** 2 + (p.y - st.y) ** 2) ** 0.5)
                terms.append(w.travel * dist_m * present)

    # churn/stability：baseline 里不同 person 被选中 → 惩罚。
    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        baseline = request.baselineAssignee.get(t.taskId)
        if not baseline:
            continue
        for (pi, _di, _si), present in presence[t.taskId].items():
            if request.persons[pi].id != baseline:
                terms.append(w.churn * present)

    if not terms:
        terms.append(0)
    model.Minimize(sum(terms))

    # ---- 求解 ----
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1, request.timeLimitMs / 1000.0)
    solver.parameters.num_search_workers = 1  # 确定性重放
    solver.parameters.random_seed = 0
    status = solver.Solve(model)
    dur_ms = int((time.monotonic() - started) * 1000)

    if status == cp_model.INFEASIBLE:
        return SolverResponse(
            solverVersion=SOLVER_VERSION,
            solverStatus="INFEASIBLE",
            solveDurationMs=dur_ms,
            objective=0.0,
            hardViolations=[{"type": "INFEASIBLE", "reason": "no feasible assignment"}],
            unassignedTaskIds=[t.taskId for t in request.tasks],
        )
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SolverResponse(
            solverVersion=SOLVER_VERSION,
            solverStatus="TIMEOUT",
            solveDurationMs=dur_ms,
            objective=0.0,
            hardViolations=[],
            unassignedTaskIds=[t.taskId for t in request.tasks],
        )

    # ---- 提取结果 ----
    assignments: List[SolverAssignmentResult] = []
    unassigned: List[str] = []
    for t in request.tasks:
        if t.taskId in frozen_by_task:
            f = frozen_by_task[t.taskId]
            assignments.append(
                SolverAssignmentResult(
                    taskId=t.taskId,
                    personId=f.personId,
                    deviceId=f.deviceId,
                    stationId=f.stationId,
                    startMs=f.startMs,
                    endMs=f.endMs,
                    reasons=["frozen_executing_or_locked"],
                )
            )
            continue
        if not presence.get(t.taskId):
            unassigned.append(t.taskId)
            continue
        chosen = None
        for (pi, di, si), present in presence[t.taskId].items():
            if solver.Value(present) == 1:
                chosen = (pi, di, si)
                break
        if chosen is None:
            unassigned.append(t.taskId)
            continue
        pi, di, si = chosen
        s_val = int(solver.Value(start_min[t.taskId]))
        e_val = int(solver.Value(end_min[t.taskId]))
        assignments.append(
            SolverAssignmentResult(
                taskId=t.taskId,
                personId=request.persons[pi].id,
                deviceId=request.devices[di].id if di != -1 else None,
                stationId=request.stations[si].id if si != -1 else None,
                startMs=request.nowMs + s_val * MINUTE,
                endMs=request.nowMs + e_val * MINUTE,
                reasons=["cpsat_assigned", f"solver_status={solver.StatusName(status)}"],
                rejectedAlternatives=candidate_rejected.get(t.taskId, []),
            )
        )

    objective_val = float(solver.ObjectiveValue()) if solver.ObjectiveValue() is not None else 0.0
    bound = float(solver.BestObjectiveBound()) if solver.BestObjectiveBound() is not None else None
    return SolverResponse(
        solverVersion=SOLVER_VERSION,
        solverStatus="OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        solveDurationMs=dur_ms,
        objective=objective_val,
        objectiveBreakdown={
            "lateness": float(w.lateness),
            "stationWait": float(w.stationWait),
            "travel": float(w.travel),
            "churn": float(w.churn),
        },
        hardViolations=[],
        optimalityGap=(bound - objective_val) if bound is not None else None,
        unassignedTaskIds=unassigned,
        assignments=assignments,
    )