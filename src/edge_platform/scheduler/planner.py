"""Top-K 规划器：用不同权重策略生成多份备选方案，供人工比选。

默认三策略：
- Plan A：交付优先（on_time 权重高）；
- Plan B：负荷平衡优先（body_load 权重高）；
- Plan C：均衡（默认权重）。

每份方案都绑定世界状态快照版本；无可行解任务记录 violation 不造假。

纯 Python 标准库实现。
"""

from edge_platform.spatial import new_id, now_iso

from .models import PLAN_SHADOW
from .optimizer import GreedyOptimizer
from .priority import EffectivePriorityCalculator
from .scoring import Scorer, ScoringWeights, WeightAuditLog

# 默认三策略（覆盖 ScoringWeights 与 EffectivePriorityCalculator 的权重键）
DEFAULT_WEIGHT_STRATEGIES = {
    "A_delivery": {
        "scoring": {"w2_on_time": 3.0, "w5_travel_distance": 0.02},
        "effective": {"deadline": 2.0, "base": 1.0},
    },
    "B_load_balance": {
        "scoring": {"w4_body_load": 3.0},
        "effective": {"aging": 1.5},
    },
    "C_balanced": {
        "scoring": {},
        "effective": {},
    },
}


class Planner:
    """Top-K 规划器：generate_top_k 产出多份影子方案。"""

    def __init__(
        self,
        optimizer,
        route_planner,
        world_state_service,
        weight_strategies=None,
    ):
        self.optimizer = optimizer
        self.route_planner = route_planner
        self.world_state_service = world_state_service
        self.weight_strategies = weight_strategies or dict(DEFAULT_WEIGHT_STRATEGIES)

    def _base_components(self):
        """从基础 GreedyOptimizer 抽取可复用的组件。"""
        opt = self.optimizer
        eff_calc = getattr(opt, "effective_priority_calc", None)
        effective = dict(eff_calc.weights) if eff_calc is not None else {}
        return {
            "planner_route": getattr(opt, "planner_route", None),
            "constraints": getattr(opt, "constraints", None),
            "generator": getattr(opt, "generator", None),
            "scoring_weights": (
                getattr(getattr(opt, "scorer", None), "weights", None) or ScoringWeights()
            ),
            "effective_weights": effective,
        }

    def _build_strategy_optimizer(self, strategy_weights):
        """按策略权重构建一个 GreedyOptimizer（克隆基础组件 + 覆盖权重）。"""
        base = self._base_components()
        scoring = base["scoring_weights"].to_dict()
        scoring.update(strategy_weights.get("scoring", {}))
        effective = dict(base["effective_weights"])
        effective.update(strategy_weights.get("effective", {}))
        scorer = Scorer(ScoringWeights.from_dict(scoring), WeightAuditLog())
        eff_calc = EffectivePriorityCalculator(effective)
        return GreedyOptimizer(
            planner_route=base["planner_route"] or self.route_planner,
            scorer=scorer,
            effective_priority_calc=eff_calc,
            weights=effective,
            constraints=base["constraints"],
            generator=base["generator"],
        )

    def generate_top_k(self, world_state, tasks, policy, k=3):
        """生成 k 份影子方案（按策略依次取，至多 k 份）。"""
        plans = []
        names = list(self.weight_strategies.keys())
        for idx in range(k):
            name = names[idx % len(names)] if names else f"strategy_{idx}"
            strategy_weights = self.weight_strategies.get(name, {})
            optimizer = self._build_strategy_optimizer(strategy_weights)
            plan = optimizer.solve(world_state, tasks, None, policy)
            plan.plan_id = new_id("PLN")
            plan.version = 1
            plan.status = PLAN_SHADOW
            plan.world_state_version = getattr(world_state, "snapshot_id", "") or ""
            plan.valid_until = ""
            plan.created_at = now_iso()
            plan.objective_breakdown = dict(plan.objective_breakdown)
            plan.objective_breakdown["strategy"] = name
            plans.append(plan)
        return plans
