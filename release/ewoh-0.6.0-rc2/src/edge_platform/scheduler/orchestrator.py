"""调度编排（人在回路）：影子运行 → 建议 → 班组长确认 → 执行 → 结果回流。

对应 spec「人在回路与调度纪律」与「安全边界（扩展，不可变）」：
- 调度先影子运行只记录不执行（propose → SHADOW）；
- 班组长确认时必须选择或填写理由，形成审计记录（confirm）；
- 未经确认不得自动执行（execute 在非 CONFIRMED 状态下拒绝，不触碰设备安全控制）；
- 执行结果回流用于学习闭环（feedback）。

安全不变量：本模块无任何自动执行旁路；execute 仅在 CONFIRMED 后标记 EXECUTED，
不向设备下发任何安全控制指令（急停/限扭/关节实时控制等保留在设备控制器本地）；
未经授权自动调度为 0。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso

from .candidate import CandidateGenerator
from .explanation import explain_candidate
from .scoring import Scorer, ScoringWeights, WeightAuditLog

# 调度请求状态机
SHADOW = "SHADOW"  # 影子运行：只记录不执行
PROPOSED = "PROPOSED"  # 影子指标达标后升级为建议
CONFIRMED = "CONFIRMED"  # 班组长已确认
REJECTED = "REJECTED"  # 班组长已否决
EXECUTED = "EXECUTED"  # 已执行（仅标记，不触碰设备安全控制）


@dataclass
class ScheduleRequest:
    """调度请求：触发上下文 + 任务 + 候选列表 + 状态机 + 确认/执行/回流记录。"""

    request_id: str
    ts: str
    trigger: dict
    task: dict
    status: str = SHADOW
    candidates: list = field(default_factory=list)
    ranked_candidate_ids: list = field(default_factory=list)
    confirmed_plan_id: str = None
    confirmations: list = field(default_factory=list)
    rejections: list = field(default_factory=list)
    execution_record: dict = None
    feedback_records: list = field(default_factory=list)

    @property
    def ts_ms(self):
        """请求时间戳（毫秒），便于排序与审计（复用 inference.ts_to_ms）。"""
        return ts_to_ms(self.ts)

    def to_dict(self):
        return {
            "request_id": self.request_id,
            "ts": self.ts,
            "ts_ms": self.ts_ms,
            "trigger": dict(self.trigger),
            "task": dict(self.task),
            "status": self.status,
            "candidates": [c.to_dict() if hasattr(c, "to_dict") else c for c in self.candidates],
            "ranked_candidate_ids": list(self.ranked_candidate_ids),
            "confirmed_plan_id": self.confirmed_plan_id,
            "confirmations": list(self.confirmations),
            "rejections": list(self.rejections),
            "execution_record": self.execution_record,
            "feedback_records": list(self.feedback_records),
        }


class Scheduler:
    """调度编排器：propose / promote_to_proposed / confirm / reject / execute / feedback。

    人在回路不变量：execute 仅在 CONFIRMED 后标记 EXECUTED；无任何自动执行旁路。
    """

    def __init__(self, constraints, scorer=None, generator=None):
        self.constraints = constraints
        self.generator = generator or CandidateGenerator()
        if scorer is None:
            self.audit_log = WeightAuditLog()
            self.scorer = Scorer(ScoringWeights(), self.audit_log)
        else:
            self.scorer = scorer
            self.audit_log = getattr(scorer, "audit_log", WeightAuditLog())
        self._requests = {}

    # ---- 内部工具 ----

    def _get(self, request_id):
        req = self._requests.get(request_id)
        if req is None:
            raise KeyError(f"调度请求不存在: {request_id}")
        return req

    def _build_candidate_ctx(self, cand, ctx):
        """从全局 ctx 抽取该候选对应的 person/station 评分上下文（真实值）。"""
        ctx = ctx or {}
        persons_state = ctx.get("persons_state", {}) or {}
        stations_state = ctx.get("stations_state", {}) or {}
        pstate = persons_state.get(cand.person_id, {}) or {}
        sstate = stations_state.get(cand.station_id, {}) or {}

        cand_ctx = {
            "expected_production_uplift": pstate.get(
                "expected_production_uplift", ctx.get("expected_production_uplift", 0.0)
            ),
            "on_time_probability": pstate.get("on_time_probability", ctx.get("on_time_probability", 0.0)),
            "current_load": pstate.get("current_load", 0.0),
            "safety_risk": pstate.get("safety_risk"),
            "recent_risk_events": pstate.get("recent_risk_events", []),
            "is_changeover": bool(pstate.get("is_changeover", ctx.get("is_changeover", False))),
            "body_load_baseline": pstate.get("body_load_baseline", 0.5),
        }
        # 移动距离：优先预计算，否则用 person/station pose 经 spatial.distance() 计算
        if pstate.get("distance_to_station") is not None:
            cand_ctx["distance_to_station"] = pstate.get("distance_to_station")
        else:
            cand_ctx["person_pose"] = pstate.get("pose")
            cand_ctx["station_pose"] = sstate.get("pose")
        return cand_ctx

    # ---- 主流程 ----

    def propose(self, task, persons, devices, ctx=None):
        """生成候选、评分、排序、附理由；返回 SHADOW 状态的 ScheduleRequest。

        影子运行只记录不执行（spec："调度先影子运行只记录不执行"）。
        """
        ctx = ctx or {}
        request_id = new_id("REQ")
        ts = now_iso()

        candidates = self.generator.generate(task, persons, devices, self.constraints, ctx)

        # 仅对通过硬约束的候选评分；未通过候选保留违规原因用于解释
        for cand in candidates:
            if cand.passed:
                cand_ctx = self._build_candidate_ctx(cand, ctx)
                total, breakdown = self.scorer.score(cand, cand_ctx)
                breakdown = dict(breakdown)
                # 把基线写入明细，供理由生成引用真实值
                breakdown["body_load_baseline"] = cand_ctx.get("body_load_baseline", 0.5)
                cand.score = total
                cand.score_breakdown = breakdown
            cand.explanation = explain_candidate(cand)

        # 排序：通过候选按评分降序在前；未通过候选置后（保留以解释拦截原因）
        passed = [c for c in candidates if c.passed]
        failed = [c for c in candidates if not c.passed]
        passed.sort(
            key=lambda c: c.score if c.score is not None else float("-inf"),
            reverse=True,
        )
        ranked = passed + failed
        ranked_ids = [c.candidate_id for c in ranked]

        req = ScheduleRequest(
            request_id=request_id,
            ts=ts,
            trigger=dict(ctx.get("trigger", {}) or {}),
            task=dict(task),
            status=SHADOW,
            candidates=ranked,
            ranked_candidate_ids=ranked_ids,
        )
        self._requests[request_id] = req
        return req

    def promote_to_proposed(self, request_id):
        """影子指标达标后，将请求由 SHADOW 升级为 PROPOSED（建议模式）。"""
        req = self._get(request_id)
        if req.status != SHADOW:
            raise ValueError(f"仅 SHADOW 状态可升级为 PROPOSED，当前状态：{req.status}")
        req.status = PROPOSED
        return req

    def confirm(self, request_id, plan_id, actor_id, reason):
        """班组长确认调度方案：必须填写理由，形成审计记录；状态 → CONFIRMED。

        spec："班组长确认时必须选择或填写理由，形成审计记录"；reason 为空则拒绝确认。
        """
        req = self._get(request_id)
        if not reason or not str(reason).strip():
            raise ValueError("确认必须填写理由（spec：班组长确认时必须选择或填写理由）")
        record = {
            "request_id": request_id,
            "plan_id": plan_id,
            "actor_id": actor_id,
            "reason": str(reason).strip(),
            "ts": now_iso(),
            "ts_ms": ts_to_ms(now_iso()),
        }
        req.confirmations.append(record)
        req.confirmed_plan_id = plan_id
        req.status = CONFIRMED
        return record

    def reject(self, request_id, actor_id, reason):
        """班组长否决调度方案：记录理由，状态 → REJECTED。

        spec："人工可在任何阶段否决"；"员工应能申诉、标记误判或说明特殊情况"。
        """
        req = self._get(request_id)
        record = {
            "request_id": request_id,
            "actor_id": actor_id,
            "reason": str(reason or "").strip(),
            "ts": now_iso(),
            "ts_ms": ts_to_ms(now_iso()),
        }
        req.rejections.append(record)
        req.status = REJECTED
        return record

    def execute(self, request_id):
        """执行调度方案：仅 CONFIRMED 状态可执行；不触碰设备安全控制。

        spec："未经确认不得自动执行"。非 CONFIRMED 状态返回拒绝记录，状态不变。
        本方法仅标记 EXECUTED 用于结果回流，不向设备下发任何安全控制指令
        （急停/限扭/关节实时控制等保留在设备控制器本地）。
        """
        req = self._get(request_id)
        if req.status != CONFIRMED:
            # 安全不变量：拒绝执行，状态保持不变；无任何自动执行旁路
            return {
                "request_id": request_id,
                "executed": False,
                "reason": f"未经确认不得自动执行（当前状态：{req.status}）",
                "ts": now_iso(),
            }
        record = {
            "request_id": request_id,
            "executed": True,
            "plan_id": req.confirmed_plan_id,
            "ts": now_iso(),
            "ts_ms": ts_to_ms(now_iso()),
            "note": "仅标记执行状态用于结果回流，未触碰设备安全控制",
        }
        req.execution_record = record
        req.status = EXECUTED
        return record

    def feedback(self, request_id, actual_outcome):
        """执行结果回流：记录实际产出，用于学习闭环校准规则/模型/调度参数。

        spec："执行结果回流"；actual_outcome 为结构化结果字典。
        """
        req = self._get(request_id)
        record = {
            "request_id": request_id,
            "actual_outcome": (dict(actual_outcome) if isinstance(actual_outcome, dict) else actual_outcome),
            "ts": now_iso(),
            "ts_ms": ts_to_ms(now_iso()),
        }
        req.feedback_records.append(record)
        return record

    def get_request(self, request_id):
        """按 ID 取调度请求（供审计/回放使用）。"""
        return self._get(request_id)
