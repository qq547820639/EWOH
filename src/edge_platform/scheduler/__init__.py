"""决策与调度层：硬约束过滤、候选生成、多目标评分、理由生成、人工确认（人在回路）。

对应 spec「决策与调度层」与「人在回路与调度纪律」：
- 多目标优化 J = w1*产量 + w2*准时率 − w3*安全风险 − w4*人体负荷 − w5*移动距离 − w6*换岗成本；
  权重可配置且每次调整入审计（WeightAuditLog），权重不得由算法自行隐藏决定。
- 硬约束过滤（技能/工位授权/健康禁忌/禁区/班次休息/外骨骼型号兼容/设备故障/安全规则），
  任意违规即取消候选资格（验收："硬约束违规为 0"）。
- 流程：候选生成 → 多目标评分 → 排序 → 理由生成 → 人工确认 → 执行结果回流。
- 安全纪律：调度先影子运行只记录不执行（SHADOW）；班组长确认时必须填写理由；
  未经确认不得自动执行（execute 仅在 CONFIRMED 后标记 EXECUTED，不触碰设备安全控制）；
  未经授权自动调度为 0。

纯 Python 标准库实现；不依赖 OR-tools / pulp 等求解器，约束过滤与评分均为手写规则。
"""

from .appeal import (  # noqa: E402,F401
    AppealChannel,
    AppealRecord,
    AppealStats,
    AppealType,
)
from .candidate import Candidate, CandidateGenerator
from .constraints import (
    DEVICE_FAULT,
    EXO_MODEL_COMPAT,
    FORBIDDEN_ZONE,
    HEALTH_TABOO,
    SAFETY,
    SHIFT_REST,
    SKILL,
    STATION_AUTH,
    ConstraintViolation,
    HardConstraints,
)
from .explanation import Explanation, explain_candidate, explain_plan
from .models import (
    PLAN_APPROVED,
    PLAN_ARCHIVED,
    PLAN_DISPATCHED,
    PLAN_EXPIRED,
    PLAN_PENDING_REVIEW,
    PLAN_SHADOW,
    PLAN_SIMULATING,
    PLAN_TERMINAL,
    PLAN_TRANSITIONS,
    RESOURCE_AVAILABLE,
    RESOURCE_BUSY,
    RESOURCE_DEGRADED,
    RESOURCE_MAINTENANCE,
    RESOURCE_OFFLINE,
    RESOURCE_RESERVED,
    RESOURCE_STATUSES,
    TASK_CANCELLED,
    TASK_COMPLETED,
    TASK_DISPATCHED,
    TASK_DRAFT,
    TASK_EXCEPTION,
    TASK_EXECUTING,
    TASK_PAUSED,
    TASK_PENDING_APPROVAL,
    TASK_PENDING_CONFIRM,
    TASK_PENDING_DISPATCH,
    TASK_RECEIVED,
    TASK_TERMINAL,
    TASK_TRANSITIONS,
    Assignment,
    CandidateAssignment,
    Reservation,
    ResourceState,
    ScheduleFeedback,
    SchedulePlan,
    ScheduleRequestMW,
    Task,
    WorldStateSnapshot,
    validate_plan_transition,
    validate_task_transition,
)
from .optimizer import CpSatOptimizer, GreedyOptimizer, Optimizer
from .orchestrator import (
    CONFIRMED,
    EXECUTED,
    PROPOSED,
    REJECTED,
    SHADOW,
    Scheduler,
    ScheduleRequest,
)

# ---- 联合智能调度核心（Task 新增）----
from .planner import Planner
from .priority import EffectivePriorityCalculator
from .replanner import Replanner
from .resources import ResourceStateService
from .repository import (
    SchedulingRepository,
    VersionConflictError,
)
from .reservation import (
    ReservationConflictError,
    ReservationService,
)
from .route_planner import (
    EuclideanRoutePlanner,
    GraphRoutePlanner,
    Route,
    RoutePlanner,
    build_route_planner,
)
from .scheduler_service import (
    IllegalStateError,
    PlanConflictError,
    PlanStaleError,
    SchedulerService,
)
from .scoring import Scorer, ScoringWeights, WeightAuditEntry, WeightAuditLog
from .world_state import WorldStateService

__all__ = [
    # 硬约束
    "ConstraintViolation",
    "HardConstraints",
    "SKILL",
    "STATION_AUTH",
    "HEALTH_TABOO",
    "FORBIDDEN_ZONE",
    "SHIFT_REST",
    "EXO_MODEL_COMPAT",
    "DEVICE_FAULT",
    "SAFETY",
    # 候选生成
    "Candidate",
    "CandidateGenerator",
    # 评分
    "ScoringWeights",
    "WeightAuditLog",
    "WeightAuditEntry",
    "Scorer",
    # 理由
    "Explanation",
    "explain_candidate",
    "explain_plan",
    # 编排（人在回路）
    "ScheduleRequest",
    "Scheduler",
    "SHADOW",
    "PROPOSED",
    "CONFIRMED",
    "REJECTED",
    "EXECUTED",
    # 员工申诉通道（Task 25.4）
    "AppealType",
    "AppealRecord",
    "AppealStats",
    "AppealChannel",
    # 学习闭环（Task 31）
    "ScheduleOutcome",
    "LearningStats",
    "CalibrationSuggestion",
    "LearningLoop",
    # 联合智能调度核心（Task 新增）
    "PLAN_SHADOW",
    "PLAN_SIMULATING",
    "PLAN_PENDING_REVIEW",
    "PLAN_APPROVED",
    "PLAN_DISPATCHED",
    "PLAN_EXPIRED",
    "PLAN_ARCHIVED",
    "PLAN_TERMINAL",
    "PLAN_TRANSITIONS",
    "validate_plan_transition",
    "TASK_DRAFT",
    "TASK_PENDING_CONFIRM",
    "TASK_PENDING_APPROVAL",
    "TASK_PENDING_DISPATCH",
    "TASK_DISPATCHED",
    "TASK_RECEIVED",
    "TASK_EXECUTING",
    "TASK_PAUSED",
    "TASK_EXCEPTION",
    "TASK_COMPLETED",
    "TASK_CANCELLED",
    "TASK_TERMINAL",
    "TASK_TRANSITIONS",
    "validate_task_transition",
    "RESOURCE_AVAILABLE",
    "RESOURCE_RESERVED",
    "RESOURCE_BUSY",
    "RESOURCE_DEGRADED",
    "RESOURCE_OFFLINE",
    "RESOURCE_MAINTENANCE",
    "RESOURCE_STATUSES",
    "ResourceState",
    "Task",
    "ScheduleRequestMW",
    "CandidateAssignment",
    "SchedulePlan",
    "Assignment",
    "Reservation",
    "WorldStateSnapshot",
    "ScheduleFeedback",
    "EffectivePriorityCalculator",
    "Route",
    "RoutePlanner",
    "GraphRoutePlanner",
    "EuclideanRoutePlanner",
    "build_route_planner",
    "WorldStateService",
    "ResourceStateService",
    "ReservationService",
    "ReservationConflictError",
    "Optimizer",
    "GreedyOptimizer",
    "CpSatOptimizer",
    "Planner",
    "SchedulerService",
    "SchedulingRepository",
    "VersionConflictError",
    "PlanStaleError",
    "PlanConflictError",
    "IllegalStateError",
    "Replanner",
]

from .learning_loop import (  # noqa: E402,F401
    CalibrationSuggestion,
    LearningLoop,
    LearningStats,
    ScheduleOutcome,
)
