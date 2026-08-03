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
from .orchestrator import (
    CONFIRMED,
    EXECUTED,
    PROPOSED,
    REJECTED,
    SHADOW,
    Scheduler,
    ScheduleRequest,
)
from .scoring import Scorer, ScoringWeights, WeightAuditEntry, WeightAuditLog

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
]

from .learning_loop import (  # noqa: E402,F401
    CalibrationSuggestion,
    LearningLoop,
    LearningStats,
    ScheduleOutcome,
)
