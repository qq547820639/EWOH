"""场景仿真层：多方案生成、单方案指标计算、方案对比。

对应 spec「场景仿真层」与「方案对比」场景：调度前生成至少三个方案
（保持现状/最小调整/产能优先/安全与负荷均衡优先/设备异常应急），每个方案展示预计产量、
延误风险、人员负荷变化、行走距离、外骨骼电量消耗、拥堵变化、受影响人员、关键假设、置信度；
方案对比不只显示总分，需展示分项指标（如「产能优先方案节拍提升 4.2% 但高负荷人员 3 人、
低电量风险 2 台；负荷均衡方案节拍提升 1.8% 但高负荷人员 0 人、低电量风险 0 台」）。

安全纪律（spec 不可变）：本包只生成建议方案供班组长确认，不执行任何调度；安全控制不进入平台，
未经确认不得自动执行。与 scheduler 包耦合宽松（接受 duck-typed 输入）。

纯 Python 标准库实现。
"""

from .metrics import PlanMetrics, compute_metrics
from .simulator import PlanType, Plan, ScenarioSimulator
from .comparison import PlanComparison, compare, format_comparison_table

__all__ = [
    # 指标
    "PlanMetrics", "compute_metrics",
    # 方案生成
    "PlanType", "Plan", "ScenarioSimulator",
    # 方案对比
    "PlanComparison", "compare", "format_comparison_table",
]
