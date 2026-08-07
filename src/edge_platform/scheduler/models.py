"""联合智能调度的核心数据模型与状态机常量。

状态机以契约文件 contracts/state-machines/plan.yaml 与 task.yaml 为 canonical：
- Plan：shadow → simulating → pending_review → approved → dispatched（+expired/archived）。
- Task：draft → pending_confirm → pending_approval → pending_dispatch
  → dispatched → received → executing → paused → exception → completed / cancelled。

非法状态转换必须由后端拒绝（抛 ValueError），不能只靠前端拦截。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field

from edge_platform.spatial import new_id, now_iso

# ---------- Plan 状态机 ----------

PLAN_SHADOW = "shadow"
PLAN_SIMULATING = "simulating"
PLAN_PENDING_REVIEW = "pending_review"
PLAN_APPROVED = "approved"
PLAN_DISPATCHED = "dispatched"
PLAN_EXPIRED = "expired"
PLAN_ARCHIVED = "archived"

PLAN_TERMINAL = frozenset({PLAN_EXPIRED, PLAN_ARCHIVED})

# 合法 Plan 状态转换（from -> 可达 to 集合），与 contracts/state-machines/plan.yaml 一致
PLAN_TRANSITIONS = {
    PLAN_SHADOW: {PLAN_SIMULATING},
    PLAN_SIMULATING: {PLAN_SHADOW, PLAN_PENDING_REVIEW},
    PLAN_PENDING_REVIEW: {PLAN_APPROVED, PLAN_SHADOW},
    PLAN_APPROVED: {PLAN_DISPATCHED, PLAN_EXPIRED},
}


def validate_plan_transition(from_state, to_state):
    """校验 Plan 状态转换合法性；非法则抛 ValueError。

    "any → archived"（archive）为契约允许的通用归档路径，另行放行。
    """
    if to_state == PLAN_ARCHIVED:
        return True
    allowed = PLAN_TRANSITIONS.get(from_state, set())
    if to_state in allowed:
        return True
    raise ValueError(
        f"非法 Plan 状态转换: {from_state!r} -> {to_state!r}（契约 plan.yaml）"
    )


# ---------- Task 状态机 ----------

TASK_DRAFT = "draft"
TASK_PENDING_CONFIRM = "pending_confirm"
TASK_PENDING_APPROVAL = "pending_approval"
TASK_PENDING_DISPATCH = "pending_dispatch"
TASK_DISPATCHED = "dispatched"
TASK_RECEIVED = "received"
TASK_EXECUTING = "executing"
TASK_PAUSED = "paused"
TASK_EXCEPTION = "exception"
TASK_COMPLETED = "completed"
TASK_CANCELLED = "cancelled"

TASK_TERMINAL = frozenset({TASK_COMPLETED, TASK_CANCELLED})

_TASK_NON_TERMINAL = frozenset(
    {
        TASK_DRAFT,
        TASK_PENDING_CONFIRM,
        TASK_PENDING_APPROVAL,
        TASK_PENDING_DISPATCH,
        TASK_DISPATCHED,
        TASK_RECEIVED,
        TASK_EXECUTING,
        TASK_PAUSED,
        TASK_EXCEPTION,
    }
)

# 合法 Task 状态转换，与 contracts/state-machines/task.yaml 一致
TASK_TRANSITIONS = {
    TASK_DRAFT: {TASK_PENDING_CONFIRM},
    TASK_PENDING_CONFIRM: {TASK_PENDING_APPROVAL, TASK_PENDING_DISPATCH},
    TASK_PENDING_APPROVAL: {TASK_PENDING_DISPATCH, TASK_DRAFT},
    TASK_PENDING_DISPATCH: {TASK_DISPATCHED},
    TASK_DISPATCHED: {TASK_RECEIVED},
    TASK_RECEIVED: {TASK_EXECUTING},
    TASK_EXECUTING: {TASK_PAUSED, TASK_EXCEPTION, TASK_COMPLETED},
    TASK_PAUSED: {TASK_EXECUTING},
    TASK_EXCEPTION: {TASK_EXECUTING},
}


def validate_task_transition(from_state, to_state):
    """校验 Task 状态转换合法性；非法则抛 ValueError。

    "any_non_terminal → cancelled"（authorized, reason_required）为契约允许路径。
    """
    if to_state == TASK_CANCELLED and from_state in _TASK_NON_TERMINAL:
        return True
    allowed = TASK_TRANSITIONS.get(from_state, set())
    if to_state in allowed:
        return True
    raise ValueError(
        f"非法 Task 状态转换: {from_state!r} -> {to_state!r}（契约 task.yaml）"
    )


# ---------- 资源状态 ----------

RESOURCE_AVAILABLE = "AVAILABLE"
RESOURCE_RESERVED = "RESERVED"
RESOURCE_BUSY = "BUSY"
RESOURCE_DEGRADED = "DEGRADED"
RESOURCE_OFFLINE = "OFFLINE"
RESOURCE_MAINTENANCE = "MAINTENANCE"

RESOURCE_STATUSES = frozenset(
    {
        RESOURCE_AVAILABLE,
        RESOURCE_RESERVED,
        RESOURCE_BUSY,
        RESOURCE_DEGRADED,
        RESOURCE_OFFLINE,
        RESOURCE_MAINTENANCE,
    }
)


@dataclass
class ResourceState:
    """资源（人员/设备）实时状态快照。"""

    resource_id: str
    resource_type: str
    status: str = RESOURCE_AVAILABLE
    location: dict = field(default_factory=dict)
    station_id: str = ""
    zone_id: str = ""
    skills: list = field(default_factory=list)
    capabilities: list = field(default_factory=list)
    current_task_id: str = ""
    reserved_by: str = ""
    reserved_until: str = ""
    load: float = 0.0
    battery: float = 1.0
    risk: float = 0.0
    source_ts: str = ""
    updated_at: str = ""
    version: int = 1

    def __post_init__(self):
        if not self.updated_at:
            self.updated_at = now_iso()

    def to_dict(self):
        return {
            "resource_id": self.resource_id,
            "resource_type": self.resource_type,
            "status": self.status,
            "location": dict(self.location),
            "station_id": self.station_id,
            "zone_id": self.zone_id,
            "skills": list(self.skills),
            "capabilities": list(self.capabilities),
            "current_task_id": self.current_task_id,
            "reserved_by": self.reserved_by,
            "reserved_until": self.reserved_until,
            "load": self.load,
            "battery": self.battery,
            "risk": self.risk,
            "source_ts": self.source_ts,
            "updated_at": self.updated_at,
            "version": self.version,
        }


@dataclass
class Task:
    """联合调度任务模型。"""

    task_id: str
    task_type: str = ""
    priority: int = 0
    status: str = TASK_DRAFT
    station_id: str = ""
    zone_id: str = ""
    required_skills: list = field(default_factory=list)
    required_device_capabilities: list = field(default_factory=list)
    release_at: str = ""
    earliest_start: str = ""
    due_at: str = ""
    estimated_duration_sec: int = 0
    predecessor_task_ids: list = field(default_factory=list)
    exclusive_resource_ids: list = field(default_factory=list)
    load_level: float = 0.0
    safety_critical: bool = False
    version: int = 1
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = now_iso()
        if not self.updated_at:
            self.updated_at = self.created_at

    def to_dict(self):
        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "priority": self.priority,
            "status": self.status,
            "station_id": self.station_id,
            "zone_id": self.zone_id,
            "required_skills": list(self.required_skills),
            "required_device_capabilities": list(self.required_device_capabilities),
            "release_at": self.release_at,
            "earliest_start": self.earliest_start,
            "due_at": self.due_at,
            "estimated_duration_sec": self.estimated_duration_sec,
            "predecessor_task_ids": list(self.predecessor_task_ids),
            "exclusive_resource_ids": list(self.exclusive_resource_ids),
            "load_level": self.load_level,
            "safety_critical": self.safety_critical,
            "version": self.version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class ScheduleRequestMW:
    """联合调度请求（model 层，区别于 orchestrator.ScheduleRequest）。"""

    request_id: str
    trigger_type: str = ""
    task_ids: list = field(default_factory=list)
    policy_id: str = ""
    world_state_version: str = ""
    created_at: str = ""
    expires_at: str = ""
    status: str = "pending"
    created_by: str = ""

    def __post_init__(self):
        if not self.request_id:
            self.request_id = new_id("REQMW")
        if not self.created_at:
            self.created_at = now_iso()

    def to_dict(self):
        return {
            "request_id": self.request_id,
            "trigger_type": self.trigger_type,
            "task_ids": list(self.task_ids),
            "policy_id": self.policy_id,
            "world_state_version": self.world_state_version,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "status": self.status,
            "created_by": self.created_by,
        }


@dataclass
class CandidateAssignment:
    """方案内单条排程（任务-人员-设备-工位-路线-时间窗-评分）。"""

    task_id: str
    person_id: str = ""
    device_id: str = ""
    station_id: str = ""
    route: dict = field(default_factory=dict)
    route_distance_m: float = 0.0
    eta_sec: int = 0
    planned_start: str = ""
    planned_end: str = ""
    hard_constraint_results: list = field(default_factory=list)
    soft_score_breakdown: dict = field(default_factory=dict)
    score: float = 0.0
    explanation: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            "task_id": self.task_id,
            "person_id": self.person_id,
            "device_id": self.device_id,
            "station_id": self.station_id,
            "route": dict(self.route),
            "route_distance_m": self.route_distance_m,
            "eta_sec": self.eta_sec,
            "planned_start": self.planned_start,
            "planned_end": self.planned_end,
            "hard_constraint_results": [
                v.to_dict() if hasattr(v, "to_dict") else v
                for v in self.hard_constraint_results
            ],
            "soft_score_breakdown": dict(self.soft_score_breakdown),
            "score": self.score,
            "explanation": dict(self.explanation),
        }


@dataclass
class SchedulePlan:
    """联合调度方案（影子 → 待审 → 已批准 → 已派工）。"""

    plan_id: str
    request_id: str = ""
    version: int = 1
    assignments: list = field(default_factory=list)
    objective_score: float = 0.0
    objective_breakdown: dict = field(default_factory=dict)
    constraint_summary: dict = field(default_factory=dict)
    world_state_version: str = ""
    valid_until: str = ""
    status: str = PLAN_SHADOW
    created_at: str = ""
    confirmed_at: str = ""
    confirmed_by: str = ""
    confirm_reason: str = ""

    def __post_init__(self):
        if not self.plan_id:
            self.plan_id = new_id("PLN")
        if not self.created_at:
            self.created_at = now_iso()

    def to_dict(self):
        return {
            "plan_id": self.plan_id,
            "request_id": self.request_id,
            "version": self.version,
            "assignments": [
                a.to_dict() if hasattr(a, "to_dict") else dict(a)
                for a in self.assignments
            ],
            "objective_score": self.objective_score,
            "objective_breakdown": dict(self.objective_breakdown),
            "constraint_summary": dict(self.constraint_summary),
            "world_state_version": self.world_state_version,
            "valid_until": self.valid_until,
            "status": self.status,
            "created_at": self.created_at,
            "confirmed_at": self.confirmed_at,
            "confirmed_by": self.confirmed_by,
            "confirm_reason": self.confirm_reason,
        }


@dataclass
class Assignment:
    """派工后的正式任务分配记录。"""

    assignment_id: str
    task_id: str = ""
    plan_id: str = ""
    person_id: str = ""
    device_id: str = ""
    station_id: str = ""
    route: dict = field(default_factory=dict)
    planned_start: str = ""
    planned_end: str = ""
    actual_start: str = ""
    actual_end: str = ""
    status: str = TASK_PENDING_DISPATCH
    version: int = 1

    def __post_init__(self):
        if not self.assignment_id:
            self.assignment_id = new_id("ASN")

    def to_dict(self):
        return {
            "assignment_id": self.assignment_id,
            "task_id": self.task_id,
            "plan_id": self.plan_id,
            "person_id": self.person_id,
            "device_id": self.device_id,
            "station_id": self.station_id,
            "route": dict(self.route),
            "planned_start": self.planned_start,
            "planned_end": self.planned_end,
            "actual_start": self.actual_start,
            "actual_end": self.actual_end,
            "status": self.status,
            "version": self.version,
        }


@dataclass
class Reservation:
    """资源预约（时间窗绑定，冲突时禁止覆盖）。"""

    reservation_id: str
    resource_id: str = ""
    assignment_id: str = ""
    plan_id: str = ""
    start_at: str = ""
    end_at: str = ""
    expires_at: str = ""
    status: str = "active"
    version: int = 1

    def __post_init__(self):
        if not self.reservation_id:
            self.reservation_id = new_id("RES")

    def to_dict(self):
        return {
            "reservation_id": self.reservation_id,
            "resource_id": self.resource_id,
            "assignment_id": self.assignment_id,
            "plan_id": self.plan_id,
            "start_at": self.start_at,
            "end_at": self.end_at,
            "expires_at": self.expires_at,
            "status": self.status,
            "version": self.version,
        }


@dataclass
class WorldStateSnapshot:
    """世界状态快照：聚合人员/设备/任务/工位/分配/预约/事件的时间切片。"""

    snapshot_id: str
    timestamp: str = ""
    persons: list = field(default_factory=list)
    devices: list = field(default_factory=list)
    tasks: list = field(default_factory=list)
    stations: list = field(default_factory=list)
    assignments: list = field(default_factory=list)
    reservations: list = field(default_factory=list)
    events: list = field(default_factory=list)
    topology_version: str = ""

    def __post_init__(self):
        if not self.snapshot_id:
            self.snapshot_id = new_id("WS")
        if not self.timestamp:
            self.timestamp = now_iso()

    def to_dict(self):
        return {
            "snapshot_id": self.snapshot_id,
            "timestamp": self.timestamp,
            "persons": list(self.persons),
            "devices": list(self.devices),
            "tasks": list(self.tasks),
            "stations": list(self.stations),
            "assignments": list(self.assignments),
            "reservations": list(self.reservations),
            "events": list(self.events),
            "topology_version": self.topology_version,
        }


@dataclass
class ScheduleFeedback:
    """执行结果回流：预测 vs 实际的偏差记录，用于学习闭环。"""

    feedback_id: str
    plan_id: str = ""
    assignment_id: str = ""
    accepted: bool = False
    reject_reason: str = ""
    operator_comment: str = ""
    predicted: dict = field(default_factory=dict)
    actual: dict = field(default_factory=dict)

    def __post_init__(self):
        if not self.feedback_id:
            self.feedback_id = new_id("FB")

    def to_dict(self):
        return {
            "feedback_id": self.feedback_id,
            "plan_id": self.plan_id,
            "assignment_id": self.assignment_id,
            "accepted": self.accepted,
            "reject_reason": self.reject_reason,
            "operator_comment": self.operator_comment,
            "predicted": dict(self.predicted),
            "actual": dict(self.actual),
        }
