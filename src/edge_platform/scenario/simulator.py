"""场景仿真层 — 多方案生成。

对应 spec「场景仿真层」与「方案对比」：调度前生成至少三个方案（保持现状/最小调整/
产能优先/安全与负荷均衡优先/设备异常应急），每个方案展示分项指标，方案对比不只显示总分。

各方案策略（权衡明确，供班组长在地图上比较）：
- KEEP_CURRENT：保持当前分配不变，按现状计算指标（基准对照）。
- MINIMAL_ADJUST：至多调整一个人员/工位以缓解当前最严重瓶颈，最小化变更影响。
- CAPACITY_FIRST：优先把高产出任务打包给速度最快的人员，最大化预计产量；接受部分人员超负荷
  （产量高、高负荷人员多、可能伴随低电量风险）。
- SAFETY_BALANCED：优先均衡人员负荷（无人超过高负荷阈值）并优先使用健康设备、减少行走距离；
  接受预计产量下降（产量低、高负荷人员 0、低电量风险 0）。
- EQUIPMENT_EMERGENCY：设备故障/低电量时，把受影响人员重新分配到健康设备/工位，保障安全。

安全纪律（spec 不可变）：本模块只生成建议方案供班组长确认，不执行任何调度；安全控制不进入平台，
未经确认不得自动执行。schedule_request 可为 ScheduleRequest / dict / None（duck-typed），
方案生成主要由 ctx 驱动，与 scheduler 包耦合宽松。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field
from enum import Enum

from edge_platform.spatial import new_id
from .metrics import compute_metrics


class PlanType(str, Enum):
    """方案类型（spec「场景仿真层」五类方案）。"""
    KEEP_CURRENT = "KEEP_CURRENT"                # 保持现状
    MINIMAL_ADJUST = "MINIMAL_ADJUST"            # 最小调整
    CAPACITY_FIRST = "CAPACITY_FIRST"            # 产能优先
    SAFETY_BALANCED = "SAFETY_BALANCED"          # 安全与负荷均衡优先
    EQUIPMENT_EMERGENCY = "EQUIPMENT_EMERGENCY"  # 设备异常应急


@dataclass
class Plan:
    """调度方案：类型 + 分配 + 分项指标 + 中文理由 + 置信度。"""
    plan_id: str = ""
    plan_type: str = ""
    assignment: dict = field(default_factory=dict)
    metrics: object = None      # PlanMetrics
    rationale: str = ""         # 中文理由
    confidence: float = 0.0

    def __post_init__(self):
        if not self.plan_id:
            self.plan_id = new_id("PLAN")
        # 归一化 plan_type 为字符串（兼容传入 PlanType 枚举）
        if self.plan_type and not isinstance(self.plan_type, str):
            self.plan_type = self.plan_type.value

    def to_dict(self):
        return {
            "plan_id": self.plan_id,
            "plan_type": self.plan_type,
            "assignment": {k: dict(v) for k, v in self.assignment.items()},
            "metrics": self.metrics.to_dict() if self.metrics is not None else None,
            "rationale": self.rationale,
            "confidence": self.confidence,
        }


def _get(obj, key, default=None):
    """兼容 dict / 对象的取值（duck-typed，便于接受 ScheduleRequest 或 dict）。"""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _predicted_battery(dstate, remaining_hours):
    """设备班次末预测电量（0..1）；故障设备返回 −1。"""
    if not dstate:
        return -1.0
    if dstate.get("faulty"):
        return -1.0
    battery = float(dstate.get("battery_pct", 1.0) or 1.0)
    drain = float(dstate.get("drain_per_hour", 0.0) or 0.0)
    return battery - drain * remaining_hours


class ScenarioSimulator:
    """场景仿真器：生成多方案并计算分项指标。可选注入 scorer 用于排序（duck-typed，耦合宽松）。"""

    def __init__(self, scorer=None):
        # scorer 可选：若有 rank(plans) 方法则用于排序，否则保持生成顺序
        self.scorer = scorer

    def generate_plans(self, schedule_request, ctx, types=None):
        """生成至少三个方案（spec：「至少生成三个方案」）。

        schedule_request: ScheduleRequest / dict / None（duck-typed），提供触发上下文与任务。
        ctx: 见 metrics 模块文档。
        types: 指定生成的方案类型列表，默认 [KEEP_CURRENT, CAPACITY_FIRST, SAFETY_BALANCED]。
        """
        ctx = ctx or {}
        if types is None:
            types = [PlanType.KEEP_CURRENT, PlanType.CAPACITY_FIRST,
                     PlanType.SAFETY_BALANCED]
        # 归一化为字符串值
        type_strs = [t.value if isinstance(t, PlanType) else str(t) for t in types]

        plans = []
        for pt in type_strs:
            if pt == PlanType.KEEP_CURRENT.value:
                assignment = self._keep_current(ctx)
                rationale = ("保持当前人员—工位—设备分配不变，作为基准对照；"
                             "不引入变更风险，预计产量与负荷维持现状。")
            elif pt == PlanType.MINIMAL_ADJUST.value:
                assignment = self._minimal_adjust(ctx)
                rationale = ("在现状基础上至多调整一个人员/工位，缓解当前最严重瓶颈，"
                             "最小化变更影响与换岗成本。")
            elif pt == PlanType.CAPACITY_FIRST.value:
                assignment = self._capacity_first(ctx)
                rationale = ("优先把高产出任务打包给速度最快的人员，最大化预计产量；"
                             "接受部分人员超负荷与低电量设备风险。")
            elif pt == PlanType.SAFETY_BALANCED.value:
                assignment = self._safety_balanced(ctx)
                rationale = ("优先均衡人员负荷（无人超过高负荷阈值）并优先使用健康设备、"
                             "减少行走距离；接受预计产量下降。")
            elif pt == PlanType.EQUIPMENT_EMERGENCY.value:
                assignment = self._equipment_emergency(ctx)
                rationale = ("检测到设备故障或低电量，将受影响人员重新分配到健康设备/工位，"
                             "优先保障安全连续性。")
            else:
                continue
            metrics = compute_metrics(assignment, ctx)
            plans.append(Plan(
                plan_type=pt,
                assignment=assignment,
                metrics=metrics,
                rationale=rationale,
                confidence=metrics.confidence,
            ))

        # 可选排序：scorer 若提供 rank(plans) 则采纳（duck-typed，失败则保持生成顺序）
        if self.scorer is not None and plans and hasattr(self.scorer, "rank"):
            try:
                ranked = self.scorer.rank(plans)
                if ranked:
                    plans = list(ranked)
            except Exception:
                pass
        return plans

    # ---- 各方案策略 ----

    def _keep_current(self, ctx):
        """保持现状：复制当前分配。"""
        current = ctx.get("current_assignment", {}) or {}
        return {pid: dict(a) for pid, a in current.items()}

    def _minimal_adjust(self, ctx):
        """最小调整：至多调整一个人员/工位以缓解最严重瓶颈（当前负荷最高者）。"""
        current = ctx.get("current_assignment", {}) or {}
        persons_state = ctx.get("persons_state", {}) or {}
        stations_state = ctx.get("stations_state", {}) or {}
        tasks_state = ctx.get("tasks_state", {}) or {}
        shift = ctx.get("shift", {}) or {}
        threshold = float(shift.get("load_high_threshold", 0.8))

        assignment = {pid: dict(a) for pid, a in current.items()}
        if not assignment:
            return assignment

        # 找最严重瓶颈：当前负荷最高的人员
        worst_pid = None
        worst_load = -1.0
        for pid, a in assignment.items():
            pstate = persons_state.get(pid, {}) or {}
            tstate = tasks_state.get(a.get("task_id", ""), {}) or {}
            load = (float(pstate.get("current_load", 0.0))
                    + float(tstate.get("load_add", 0.0)))
            if load > worst_load:
                worst_load = load
                worst_pid = pid

        # 无超阈值瓶颈则不调整
        if worst_pid is None or worst_load <= threshold:
            return assignment

        # 为该人员寻找负荷增量更低的替代工位
        cur_station = assignment[worst_pid].get("station_id", "")
        cur_device = assignment[worst_pid].get("device_id", "")
        candidates = []
        for sid, sstate in stations_state.items():
            if sid == cur_station:
                continue
            alt_task = sstate.get("task_id", "")
            tstate = tasks_state.get(alt_task, {}) or {}
            alt_load_add = float(tstate.get("load_add", 0.0))
            if alt_load_add < worst_load:
                candidates.append((alt_load_add, sid, alt_task))
        candidates.sort()
        if candidates:
            _, new_station, new_task = candidates[0]
            assignment[worst_pid] = {
                "station_id": new_station,
                "task_id": new_task,
                "device_id": cur_device,
            }
        return assignment

    def _capacity_first(self, ctx):
        """产能优先：高产出任务打包给最快人员，接受更高负荷与低电量风险。"""
        persons_state = ctx.get("persons_state", {}) or {}
        stations_state = ctx.get("stations_state", {}) or {}
        tasks_state = ctx.get("tasks_state", {}) or {}
        devices_state = ctx.get("devices_state", {}) or {}
        current = ctx.get("current_assignment", {}) or {}

        # 人员按速度系数降序（最快优先）；工位按任务预期产量降序（高产出优先）
        person_ids = sorted(
            persons_state.keys(),
            key=lambda pid: float(persons_state[pid].get("speed_factor", 1.0)),
            reverse=True)
        station_items = []
        for sid, sstate in stations_state.items():
            tid = sstate.get("task_id", "")
            tstate = tasks_state.get(tid, {}) or {}
            station_items.append((float(tstate.get("expected_units", 0.0)), sid, tid))
        station_items.sort(reverse=True)

        # 设备仅排除故障（产能优先不筛选电量，接受低电量风险——权衡点）
        non_faulty = [did for did, dstate in devices_state.items()
                      if not dstate.get("faulty")]
        if not non_faulty:
            non_faulty = list(devices_state.keys()) or [""]

        assignment = {}
        for i, (_, sid, tid) in enumerate(station_items):
            if i >= len(person_ids):
                break
            pid = person_ids[i]
            did = non_faulty[i % len(non_faulty)]
            assignment[pid] = {"station_id": sid, "task_id": tid, "device_id": did}
        # 未分配工位的人员保留当前分配
        for pid in person_ids:
            if pid not in assignment and pid in current:
                assignment[pid] = dict(current[pid])
        return assignment

    def _safety_balanced(self, ctx):
        """安全与负荷均衡：优先让无人超阈值，优先健康设备，接受更低产量。"""
        persons_state = ctx.get("persons_state", {}) or {}
        stations_state = ctx.get("stations_state", {}) or {}
        tasks_state = ctx.get("tasks_state", {}) or {}
        devices_state = ctx.get("devices_state", {}) or {}
        current = ctx.get("current_assignment", {}) or {}
        shift = ctx.get("shift", {}) or {}
        threshold = float(shift.get("load_high_threshold", 0.8))
        battery_low_threshold = float(shift.get("battery_low_threshold", 0.2))
        remaining_hours = float(shift.get("remaining_hours", 4.0))

        # 人员按当前负荷升序（最空闲优先接活）
        person_ids = sorted(
            persons_state.keys(),
            key=lambda pid: float(persons_state[pid].get("current_load", 0.0)))
        # 工位按任务预期产量降序（高产出优先安排）
        station_items = []
        for sid, sstate in stations_state.items():
            tid = sstate.get("task_id", "")
            tstate = tasks_state.get(tid, {}) or {}
            station_items.append((float(tstate.get("expected_units", 0.0)), sid, tid))
        station_items.sort(reverse=True)

        # 设备优先预测电量充足者（安全均衡也关注设备安全）；不足则回退到非故障
        healthy = [did for did, dstate in devices_state.items()
                   if _predicted_battery(dstate, remaining_hours) >= battery_low_threshold]
        if not healthy:
            healthy = [did for did, dstate in devices_state.items()
                       if not dstate.get("faulty")]
        if not healthy:
            healthy = [""]
        healthy.sort(key=lambda did: _predicted_battery(
            devices_state.get(did, {}), remaining_hours), reverse=True)

        assignment = {}
        used_persons = set()
        person_loads = {pid: float(persons_state[pid].get("current_load", 0.0))
                        for pid in person_ids}

        for _, sid, tid in station_items:
            tstate = tasks_state.get(tid, {}) or {}
            load_add = float(tstate.get("load_add", 0.0))
            # 寻找接此任务后不超阈值的人员（最空闲优先）
            chosen = None
            for pid in person_ids:
                if pid in used_persons:
                    continue
                if person_loads[pid] + load_add <= threshold + 1e-9:
                    chosen = pid
                    break
            if chosen is None:
                # 都会超阈值：选最空闲的（尽量减少超阈值人数）
                for pid in person_ids:
                    if pid not in used_persons:
                        chosen = pid
                        break
            if chosen is None:
                break
            used_persons.add(chosen)
            person_loads[chosen] += load_add
            did = healthy[len(assignment) % len(healthy)]
            assignment[chosen] = {"station_id": sid, "task_id": tid, "device_id": did}

        # 未分配工位的人员保留当前分配
        for pid in person_ids:
            if pid not in assignment and pid in current:
                assignment[pid] = dict(current[pid])
        return assignment

    def _equipment_emergency(self, ctx):
        """设备异常应急：把使用故障/低电量设备的人员重分配到健康设备。"""
        devices_state = ctx.get("devices_state", {}) or {}
        shift = ctx.get("shift", {}) or {}
        battery_low_threshold = float(shift.get("battery_low_threshold", 0.2))
        remaining_hours = float(shift.get("remaining_hours", 4.0))
        current = ctx.get("current_assignment", {}) or {}

        # 健康设备：预测电量充足且非故障
        healthy = [did for did, dstate in devices_state.items()
                   if _predicted_battery(dstate, remaining_hours) >= battery_low_threshold]
        if not healthy:
            return {pid: dict(a) for pid, a in current.items()}

        assignment = {pid: dict(a) for pid, a in current.items()}
        dev_idx = 0
        for pid, a in assignment.items():
            did = a.get("device_id", "")
            dstate = devices_state.get(did, {}) or {}
            need_swap = (dstate.get("faulty")
                         or _predicted_battery(dstate, remaining_hours)
                         < battery_low_threshold)
            if need_swap:
                a["device_id"] = healthy[dev_idx % len(healthy)]
                dev_idx += 1
        return assignment
