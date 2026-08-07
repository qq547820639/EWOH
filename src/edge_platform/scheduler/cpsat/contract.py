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


@dataclass
class SolverPerson:
    id: str
    status: str
    locationStationId: Optional[str]
    x: float
    y: float
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
    x: float = 0.0
    y: float = 0.0
    availableFromMs: Optional[int] = None
    executingTaskIds: List[str] = field(default_factory=list)


@dataclass
class SolverStation:
    id: str
    x: float = 0.0
    y: float = 0.0
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