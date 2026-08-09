"""CP-SAT 求解契约：与 NestJS `SolverRequest` / `SolverResponse`（shared/api.interface.ts）对齐。

仅使用标准库类型，保持 worker 与语言无关、可独立测试。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class SolverTask:
    taskId: str
    priority: float
    earliestStartMs: int
    dueMs: Optional[int]
    durationMs: int
    requiredSkills: List[str] = field(default_factory=list)
    requiredCertifications: List[str] = field(default_factory=list)
    requiredDeviceCapabilities: List[str] = field(default_factory=list)
    candidateStationIds: List[str] = field(default_factory=list)
    zoneId: Optional[str] = None
    predecessorIds: List[str] = field(default_factory=list)
    safetyCritical: bool = False
    preemptible: bool = True
    eligiblePersonIds: Optional[List[str]] = None
    eligibleDeviceIds: Optional[List[str]] = None
    # P0-2：与 Nest `SolverRequest.tasks` 对齐——技能匹配语义（ALL=全部必需，
    # ANY=任一即可；证书/能力无 ANY 语义，保持 all）。缺省 ALL 向后兼容。
    skillMatchMode: str = "ALL"
    # P0-2：统一优先级引擎产出的有效优先级分（Nest 透传；求解器当前仅记录，不参与目标）。
    effectivePriorityScore: Optional[float] = None
    # P0-3：硬性最晚完成时间（epoch ms；None=无硬截止）。与 dueMs（软 lateness）
    # 分离：dueMs 超时仅罚 lateness，mustFinishByMs 违反则任务不可分配。
    mustFinishByMs: Optional[int] = None


@dataclass
class SolverPerson:
    id: str
    status: str
    locationStationId: Optional[str]
    # 坐标 UNKNOWN 时显式 None（禁止 0,0 伪坐标）。None 坐标的人员不会参与
    # travel 目标计算；其候选资格由 eligiblePersonIds（矩阵层）先行过滤。
    x: Optional[float] = None
    y: Optional[float] = None
    skills: List[str] = field(default_factory=list)
    certifications: List[str] = field(default_factory=list)
    workload: float = 0.0
    fatigue: float = 0.0
    availableFromMs: Optional[int] = None
    executingTaskIds: List[str] = field(default_factory=list)


@dataclass
class SolverDevice:
    id: str
    status: str
    online: bool
    capabilities: List[str] = field(default_factory=list)
    batteryPct: float = 100.0
    x: Optional[float] = None
    y: Optional[float] = None
    availableFromMs: Optional[int] = None
    executingTaskIds: List[str] = field(default_factory=list)


@dataclass
class SolverStation:
    id: str
    x: Optional[float] = None
    y: Optional[float] = None
    capacity: int = 1
    executingTaskIds: List[str] = field(default_factory=list)


@dataclass
class SolverReservation:
    resourceId: str
    resourceType: str
    startMs: int
    endMs: int


@dataclass
class FrozenAssignment:
    taskId: str
    personId: Optional[str]
    deviceId: Optional[str]
    stationId: Optional[str]
    startMs: int
    endMs: int


@dataclass
class SolverWeights:
    lateness: float = 1.0
    travel: float = 1.0
    workloadBalance: float = 1.0
    stationWait: float = 1.0
    changeCost: float = 1.0
    risk: float = 1.0
    energyRisk: float = 1.0
    churn: float = 1.0
    # A2 修复：未分配惩罚（每个可分配任务未分配时的软惩罚）。
    # 缺少该项时最小化目标的最优解 = 全部留空（presence 全 0，objective=0），
    # 求解器会诚实地什么都不做。默认 1000 使分配优先于所有常规软目标。
    unassignedPenalty: float = 1000.0


@dataclass
class CandidateCost:
    """P0-4：任务 × 候选资源的权威路径成本（由 Nest TravelCostService 矩阵层计算并透传）。

    worker 内**禁止**自行用坐标算欧氏距离——坐标可能 UNKNOWN（null），
    欧氏距离会把缺失坐标当作 0,0 产生虚假成本。无矩阵数据时该候选
    不参与 travel 目标（fail-safe），而不是回退到坐标计算。
    """

    taskId: str
    personId: str
    stationId: Optional[str] = None
    distanceMeters: float = 0.0
    etaSeconds: float = 0.0
    dataQuality: str = "UNKNOWN"
    fallbackReason: Optional[str] = None


@dataclass
class SolverRequest:
    requestId: str
    snapshotVersion: str
    policyVersion: int
    solverVersion: str
    horizonMinutes: int
    nowMs: int
    weights: SolverWeights
    tasks: List[SolverTask] = field(default_factory=list)
    persons: List[SolverPerson] = field(default_factory=list)
    devices: List[SolverDevice] = field(default_factory=list)
    stations: List[SolverStation] = field(default_factory=list)
    reservations: List[SolverReservation] = field(default_factory=list)
    forbiddenZones: List[str] = field(default_factory=list)
    frozenAssignments: List[FrozenAssignment] = field(default_factory=list)
    baselineAssignee: Dict[str, Optional[str]] = field(default_factory=dict)
    # 安全硬约束：这些 person/device 完全不可指派（候选层硬过滤，fail-closed）。
    safetyBlockedPersonIds: List[str] = field(default_factory=list)
    safetyBlockedDeviceIds: List[str] = field(default_factory=list)
    # P0-4：权威路径成本矩阵（Nest TravelCostService 计算后透传）。
    # worker 只用此矩阵的 distanceMeters/etaSeconds 参与 travel 目标，绝不自行算欧氏。
    candidateCosts: List[CandidateCost] = field(default_factory=list)
    timeLimitMs: int = 10_000

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SolverRequest":
        return cls(
            requestId=str(data.get("requestId", "")),
            snapshotVersion=str(data.get("snapshotVersion", "")),
            policyVersion=int(data.get("policyVersion", 0)),
            solverVersion=str(data.get("solverVersion", "cpsat-v1")),
            horizonMinutes=int(data.get("horizonMinutes", 480)),
            nowMs=int(data.get("nowMs", 0)),
            weights=SolverWeights(**data.get("weights", {})),
            tasks=[SolverTask(**t) for t in data.get("tasks", [])],
            persons=[SolverPerson(**p) for p in data.get("persons", [])],
            devices=[SolverDevice(**d) for d in data.get("devices", [])],
            stations=[SolverStation(**s) for s in data.get("stations", [])],
            reservations=[
                SolverReservation(**r) for r in data.get("reservations", [])
            ],
            forbiddenZones=list(data.get("forbiddenZones", [])),
            frozenAssignments=[
                FrozenAssignment(**f) for f in data.get("frozenAssignments", [])
            ],
            baselineAssignee={
                k: (v if v is not None else None)
                for k, v in (data.get("baselineAssignee", {}) or {}).items()
            },
            safetyBlockedPersonIds=list(data.get("safetyBlockedPersonIds", []) or []),
            safetyBlockedDeviceIds=list(data.get("safetyBlockedDeviceIds", []) or []),
            candidateCosts=[
                CandidateCost(**c) for c in (data.get("candidateCosts", []) or [])
            ],
            timeLimitMs=int(data.get("timeLimitMs", 10_000)),
        )


@dataclass
class SolverAssignmentResult:
    taskId: str
    personId: Optional[str]
    deviceId: Optional[str]
    stationId: Optional[str]
    startMs: int
    endMs: int
    reasons: List[str] = field(default_factory=list)
    rejectedAlternatives: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class SolverResponse:
    solverVersion: str
    solverStatus: str  # OPTIMAL | FEASIBLE | FALLBACK | INFEASIBLE | TIMEOUT | UNAVAILABLE
    solveDurationMs: int
    objective: float
    objectiveBreakdown: Dict[str, float] = field(default_factory=dict)
    hardViolations: List[Dict[str, Any]] = field(default_factory=list)
    optimalityGap: Optional[float] = None
    unassignedTaskIds: List[str] = field(default_factory=list)
    assignments: List[SolverAssignmentResult] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "solverVersion": self.solverVersion,
            "solverStatus": self.solverStatus,
            "solveDurationMs": self.solveDurationMs,
            "objective": self.objective,
            "objectiveBreakdown": self.objectiveBreakdown,
            "hardViolations": self.hardViolations,
            "optimalityGap": self.optimalityGap,
            "unassignedTaskIds": self.unassignedTaskIds,
            "assignments": [
                {
                    "taskId": a.taskId,
                    "personId": a.personId,
                    "deviceId": a.deviceId,
                    "stationId": a.stationId,
                    "startMs": a.startMs,
                    "endMs": a.endMs,
                    "reasons": a.reasons,
                    "rejectedAlternatives": a.rejectedAlternatives,
                }
                for a in self.assignments
            ],
        }