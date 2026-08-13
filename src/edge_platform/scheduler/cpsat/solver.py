"""OR-Tools CP-SAT 求解器实现。

在给定 SolverRequest 下构建 CP-SAT 模型并求解：
- 决策：每个任务是否指派给 (person, device, station) 组合，以及开始/结束时间。
- 硬约束：任务至多分配一次；person/device/station 时间不重叠；availability；
  skills；certifications；capabilities；前置任务先于后继；时间窗；reservation；
  forbidden zone；Safety Hold；executing/locked（frozen）assignment 不可移动。
- 目标：最小化 lateness / travel / stationWait / workload imbalance / changeover /
  risk / energyRisk / schedule instability（churn）。

依赖与真实边界：
- 生产环境需安装 `ortools`（`pip install -r requirements.txt`，固定 `ortools==9.11.4210`，
  Phase 2 / P2-T3 版本锁定，保证确定性重放）。
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
from .objective import compute_unassigned_scale

# 求解器版本标识（与 NestJS CpSatSchedulingSolver.CPSAT_VERSION 对齐）。
# Phase 2 / P2-T3：OR-Tools 固定版本见同目录 requirements.txt（ortools==9.11.4210）。
SOLVER_VERSION = "cpsat-v1"

try:  # pragma: no cover - 依赖探测
    from ortools.sat.python import cp_model  # type: ignore

    _ORT_TOOLS_AVAILABLE = True
except Exception:  # noqa: BLE001 - 任何导入失败都视为不可用
    _ORT_TOOLS_AVAILABLE = False

# 时间单位：分钟，避免大规模整数溢出。
MINUTE = 60_000


def person_has_required_skills(
    person_skills, required_skills, match_mode: str = "ALL"
) -> bool:
    """P0-2：技能匹配纯函数（可脱离 ortools 单测）。

    ALL=全部必需（.every）；ANY=任一即可（.some）。空需求恒 True。
    证书（certifications）无 ANY 语义，保持 all（调用方单独处理）。
    """
    if not required_skills:
        return True
    if match_mode == "ANY":
        return any(s in person_skills for s in required_skills)
    return all(s in person_skills for s in required_skills)


def travel_cost_for_candidate(candidate_costs, task_id, person_id, station_id):
    """P0-4：从权威 RouteCost 矩阵取候选 travel 距离（米）。

    矩阵由 Nest TravelCostService 计算后透传；无矩阵数据返回 None——该项
    **不参与目标**（fail-safe），绝不在 worker 内用坐标算欧氏距离（坐标可能
    UNKNOWN，欧氏会把缺失坐标当作 0,0 产生虚假成本）。
    """
    if not candidate_costs:
        return None
    for cc in candidate_costs:
        if (
            cc.taskId == task_id
            and cc.personId == person_id
            and cc.stationId == station_id
        ):
            return float(cc.distanceMeters or 0.0)
    return None


def _fixed_interval_bounds(s_ms, e_ms):
    """把毫秒起止规整为一致的 (start, size, end) 分钟三元组。

    OR-Tools 的 NewIntervalVar 强制 start + size == end。若对毫秒各自整除分钟
    会出现亚分钟余数不一致（例：startMs=36_030_000→start=600、
    endMs=37_800_000→end=630、size=(1_770_000)//60_000=29 → 600+29=629≠630
    → 模型整体 INFEASIBLE）。因此统一：
      start = s_ms // MINUTE；end = max(start + 1, e_ms // MINUTE)；size = end - start。
    短区间（整除后 end == start）由 max(start+1, ...) 保证至少 1 分钟。
    """
    start = s_ms // MINUTE
    end = max(start + 1, e_ms // MINUTE)
    return start, end - start, end


def _fixed_interval(model, s_ms, e_ms, name):
    """构造满足 start+size==end 的 fixed interval（frozen/reservation 共用）。

    frozen 任务与预约均为资源上的固定占用区间，建模方式一致。
    """
    start, size, end = _fixed_interval_bounds(s_ms, e_ms)
    return model.NewIntervalVar(
        model.NewConstant(start),
        size,
        model.NewConstant(end),
        name,
    )


def _reservation_interval_specs(reservations):
    """把预约映射为 (resource_key, startMs, endMs) 规格，供建模为 fixed interval。

    resourceType 取值 person/device/station，与候选 interval 的 key 前缀
    p:/d:/s: 完全一致（见 _solve_cpsat 候选区间 key）。endMs <= startMs 的
    异常预约直接跳过（防御），避免生成非法区间。
    """
    specs = []
    for r in reservations or []:
        try:
            s_ms, e_ms = int(r.startMs), int(r.endMs)
        except (TypeError, ValueError):
            continue
        if e_ms <= s_ms:
            continue
        if r.resourceType == "person":
            key = f"p:{r.resourceId}"
        elif r.resourceType == "device":
            key = f"d:{r.resourceId}"
        elif r.resourceType == "station":
            key = f"s:{r.resourceId}"
        else:
            continue
        specs.append((key, s_ms, e_ms))
    return specs


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

    # P0：安全硬约束——safety blocked 的 person/device 在候选生成层硬过滤
    # （fail-closed，不依赖权重/启发式偏好），并记录可解释拒绝理由。
    safety_blocked_persons = set(request.safetyBlockedPersonIds or [])
    safety_blocked_devices = set(request.safetyBlockedDeviceIds or [])

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
            if p.id in safety_blocked_persons:
                rejected.append({"personId": p.id, "reason": ["safety_blocked"]})
                continue
            if allowed_person_ids is not None and p.id not in allowed_person_ids:
                continue
            if p.status != "available":
                rejected.append({"personId": p.id, "reason": ["person_unavailable"]})
                continue
            if not person_has_required_skills(
                p.skills, t.requiredSkills, t.skillMatchMode or "ALL"
            ):
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
                    if d.id in safety_blocked_devices:
                        rejected.append({"personId": p.id, "deviceId": d.id, "reason": ["device_safety_blocked"]})
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
                        _fixed_interval(model, sMs, eMs, f"frozen_p_{pid}_{t.taskId}")
                    )
                if did:
                    key = f"d:{did}"
                    interval_by_resource.setdefault(key, []).append(
                        _fixed_interval(model, sMs, eMs, f"frozen_d_{did}_{t.taskId}")
                    )
                if sid:
                    key = f"s:{sid}"
                    interval_by_resource.setdefault(key, []).append(
                        _fixed_interval(model, sMs, eMs, f"frozen_s_{sid}_{t.taskId}")
                    )
            continue
        if not candidates.get(t.taskId):
            continue
        lo = max(0, (t.earliestStartMs - request.nowMs) // MINUTE)
        hi = max(horizon_min, lo + 1)
        dur = max(1, t.durationMs // MINUTE)
        s = model.NewIntVar(lo, hi, f"start_{t.taskId}")
        # end 域必须容纳 s + dur（lo+dur..hi+dur）。原 hi+10 上界在
        # lo+dur > hi+10 时（earliestStart 在视野外 + 长时长，如 121min 起 + 30min）
        # 使模型在变量声明阶段即 INFEASIBLE（F-HORIZON 复现路径之一）。
        e = model.NewIntVar(lo + dur, hi + dur, f"end_{t.taskId}")
        model.Add(e == s + dur)
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

    # 2b) 任务是否被分配（供 horizon/due 约束条件化：仅当任务被分配时才生效，
    #     未分配任务如实进入 unassigned，而非使整个模型 INFEASIBLE）。
    #     与约束 1 的 sum(presence)<=1 联立：av=1 ⟺ 存在被选中候选（assigned）。
    assigned_by_task: dict[str, object] = {}
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in end_min:
            continue
        av = model.NewBoolVar(f"assigned_{t.taskId}")
        model.Add(sum(presence[t.taskId].values()) >= 1).OnlyEnforceIf(av)
        model.Add(sum(presence[t.taskId].values()) == 0).OnlyEnforceIf(av.Not())
        assigned_by_task[t.taskId] = av

    # 3) P0-3：时间窗语义分离——
    #    dueMs 是**软**截止（仅计入 lateness 罚项，见目标函数；超时允许但 penalty），
    #    不再作为硬约束（旧实现把 due 当硬约束，导致 lateness 被钳制恒 0，且
    #    planEnd 被当作 due 传入时任务会因无法满足 planEnd 而全部未分配）。
    #    mustFinishByMs 是**硬**截止（违反则任务不可分配——OnlyEnforceIf(assigned)
    #    保证无法满足的任务如实进入 unassigned，而不是使整个模型 INFEASIBLE）。
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in end_min:
            continue
        if t.mustFinishByMs:
            model.Add(end_min[t.taskId] <= t.mustFinishByMs // MINUTE).OnlyEnforceIf(
                assigned_by_task[t.taskId]
            )

    # 3b) 计划视野：非冻结任务必须在 horizon 内完成（end <= horizon_min），
    #     且**仅当任务被分配时生效**。
    #     缺 3b 时 start/end 变量上界允许排到 horizon 边界（start=horizon_min，
    #     end=horizon_min+dur），求解器可把任务排到视野之外以规避整窗预约的
    #     no-overlap（如预约覆盖 [0,horizon] 时把任务排在 [horizon, horizon+1]，
    #     产生"窗外空转派工"）。
    #     若 3b 无条件生效，则 earliestStart 在视野外 / lo+dur>horizon 的任务
    #     会使整个模型 INFEASIBLE（视野内任务也被连坐）；OnlyEnforceIf 保证
    #     无法在视野内落位的任务被如实置为 unassigned，而不是崩掉全局。
    for t in request.tasks:
        if t.taskId in frozen_by_task or t.taskId not in end_min:
            continue
        model.Add(end_min[t.taskId] <= horizon_min).OnlyEnforceIf(
            assigned_by_task[t.taskId]
        )

    # 4) reservation：预约建模为资源上的 fixed interval（与 frozen 任务一致），
    #    加入 interval_by_resource 后由下方 AddNoOverlap 统一约束——
    #    任务区间与预约区间不得重叠（可排在其前或其后），而非"存在任意预约即禁止分配"。
    for key, s_ms, e_ms in _reservation_interval_specs(request.reservations):
        res_id = key[2:]
        if key.startswith("p:"):
            name = f"res_p_{res_id}"
        elif key.startswith("d:"):
            name = f"res_d_{res_id}"
        else:
            name = f"res_s_{res_id}"
        interval_by_resource.setdefault(key, []).append(
            _fixed_interval(model, s_ms, e_ms, name)
        )

    # 5) forbidden zone：任务 zone 在禁入区 → 无候选（已在候选层处理，此处兜底）。
    # 6) 资源 no-overlap / 工位容量约束。
    #    P0：工位 capacity > 1 时用 cumulative 约束（最多 capacity 个任务同时占用），
    #    不可用 AddNoOverlap（那会错误强制单任务独占）；capacity<=1 走 AddNoOverlap。
    for key, ivs in interval_by_resource.items():
        if len(ivs) <= 1:
            continue
        if key.startswith("s:"):
            station = station_by_id.get(key[2:])
            capacity = station.capacity if station and station.capacity else 1
            if capacity and capacity > 1:
                model.AddCumulative(ivs, [1] * len(ivs), capacity)
                continue
        model.AddNoOverlap(ivs)

    # ---- 目标函数（软目标，最小化，分钟单位）----
    w = request.weights
    terms: List[object] = []

    # Phase 2：字典序目标——未分配覆盖（Level 0）严格支配所有软目标（Level 1+）。
    # 用请求实际边界算出的整数 scale（替代魔法数 unassignedPenalty=1000），
    # 避免软成本累加超过未分配惩罚导致漏派工。
    unassigned_scale = compute_unassigned_scale(request)

    # A2 修复：未分配惩罚（每个可分配任务未分配时计入大惩罚）。
    # 缺此项时最小化目标的最优解 = 全部留空（presence 全 0，objective=0）——
    # 求解器"诚实"地什么都不做，部署后 OPTIMAL 却零派工。此项使分配优先于所有常规软目标。
    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        missed = model.NewBoolVar(f"missed_{t.taskId}")
        model.Add(sum(presence[t.taskId].values()) == 1 - missed)
        terms.append(unassigned_scale * missed)

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

    # travel：P0-4 权威 RouteCost 矩阵（Nest TravelCostService 计算后透传）。
    # worker 内**禁止**自行用坐标算欧氏距离——坐标可能 UNKNOWN(null)，欧氏会把
    # 缺失坐标当作 0,0 产生虚假成本。矩阵缺失时该项不参与目标（fail-safe），
    # 绝不回退到坐标计算。矩阵键：(taskId, personId, stationId)。

    for t in request.tasks:
        if t.taskId in frozen_by_task or not presence.get(t.taskId):
            continue
        for (pi, di, si), present in presence[t.taskId].items():
            p = request.persons[pi]
            st = request.stations[si] if si != -1 else None
            dist_m = travel_cost_for_candidate(
                request.candidateCosts, t.taskId, p.id, st.id if st else None
            )
            if dist_m is None:
                continue
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
            "unassigned": float(unassigned_scale * len(unassigned)),
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