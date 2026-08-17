"""CP-SAT 目标分层（Phase 2）：字典序目标的未分配 scale 计算。

纯函数模块（无副作用、不依赖 ortools），供 solver.py 目标构造使用。
核心目标：把「未分配任务数」做成严格支配所有软目标（lateness/travel/churn 等）的
Level 0 目标，避免软成本累加超过魔法数 unassignedPenalty 导致漏派工。
"""

from __future__ import annotations

# 目标分层常量（Level 0 最优先）。SAFETY_BLOCK / 容量 / no-overlap / 禁入区 /
# 技能证书为硬约束，属可行性层（恒 Level 0），不进目标。
OBJECTIVE_LEVELS = {
    0: "unassigned",  # 未分配覆盖：严格支配所有软目标
    1: "lateness",
    2: "stationWait",
    3: "travel",
    4: "churn",
    5: "workloadBalance",  # 预留
    6: "energyRisk",  # 预留
    7: "risk",  # 预留
    8: "changeCost",  # 预留
}

# int64 安全余量（2^63 - 1 ≈ 9.22e18）。
_INT64_MAX = (2 ** 63) - 1

# R2-ESC-001：软目标系数整数化刻度。CP-SAT 是纯整数求解器，线性表达式
# 只接受整数系数；浮点权重/距离在构建期抛 TypeError。所有软目标系数统一
# ×COEFF_SCALE 后四舍五入为整数（0.1 精度），未分配 scale 计算同步计入
# 该刻度以保证字典序支配关系不变。
COEFF_SCALE = 10


def int_coeff(value: float) -> int:
    """软目标系数整数化（×COEFF_SCALE 四舍五入；负值截 0，权重不允许为负）。"""
    scaled = int(round(float(value) * COEFF_SCALE))
    return scaled if scaled > 0 else 0


def _soft_upper_bound(request) -> float:
    """计算软目标之和的保守上界（保证 >= 任何实际软目标之和）。"""
    w = request.weights
    horizon_min = max(1, int(request.horizonMinutes))
    n_tasks = len(request.tasks)

    # lateness / stationWait：每任务最多 horizon_min + 10 分钟。
    lateness_bound = n_tasks * (horizon_min + 10) * max(float(w.lateness), 0.0)
    wait_bound = n_tasks * (horizon_min + 10) * max(float(w.stationWait), 0.0)

    # travel：候选成本矩阵里每个 (task, candidate) 的距离 × 权重（每任务每候选至多选中一次）。
    travel_bound = sum(
        max(float(c.distanceMeters), 0.0) * max(float(w.travel), 0.0)
        for c in request.candidateCosts
    )

    # churn：每任务至多 1 次变更。
    churn_bound = n_tasks * max(float(w.churn), 0.0)

    # R2-ESC-001：solver 侧系数已 ×COEFF_SCALE 整数化，上界同步乘刻度，
    # 保证 unassigned_scale 仍严格支配缩放后的软目标之和。
    return (lateness_bound + wait_bound + travel_bound + churn_bound) * COEFF_SCALE


def compute_unassigned_scale(request) -> int:
    """返回一个整数 scale，使 scale * unassigned_count 严格支配所有软目标之和。

    即 scale > soft_upper_bound，同时保证 scale * n_tasks 不溢出 int64。
    """
    n_tasks = max(1, len(request.tasks))
    bound = _soft_upper_bound(request)
    if bound < 0:
        bound = 0.0
    scale = int(bound) + 2  # +1 严格支配，再 +1 防浮点取整误差
    if scale < 1:
        scale = 1
    # 防止 scale * n_tasks 溢出 int64。
    max_safe = _INT64_MAX // n_tasks
    if scale > max_safe:
        scale = max_safe
    return scale
