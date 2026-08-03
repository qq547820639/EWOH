"""本地大模型助手（spec Task 27）：自然语言查询/事件总结/调度方案解释/规则检索/
历史案例/交接班摘要/异常根因假设/报告生成。

对应 spec「本地大模型角色约束」与 Task 27.1/27.2：
- 27.1 实现自然语言查询/事件总结/调度方案解释/规则检索/历史案例/交接班摘要/异常根因假设/报告生成；
- 27.2 大模型不直接实时控制，不取代调度优化器；调度结果来自结构化算法，大模型不得虚构传感器
  数据或调度结果。

核心安全不变量（必须强制，由 LLMResponse 与各方法共同保证）：
1. 大模型不得直接实时控制（本模块不调用任何 actuator/execute 接口，不向设备下发任何控制指令）；
2. 不取代调度优化器（不生成新的 ScheduleRequest，只解释 Scheduler.propose() 已生成的请求）；
3. 不得虚构传感器数据或调度结果（所有引用必须来自传入的 context，引用时附 source_ref）；
4. 所有输出必须标注 generated_by_llm=True 与 not_for_direct_control=True；
5. 调度结果解释只能引用已有 ScheduleRequest，不能生成新的候选。

大模型不直接实时控制，不取代调度优化器，不虚构传感器数据或调度结果。
默认使用模板生成器 TemplateBackend（基于规则模板，不实际调用大模型 API）；
未来接入真实 LLM 时，可将 llm_backend 替换为真实 backend（Callable[[str], str]）。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso

# ---------- 意图枚举 ----------


class LLMIntent(Enum):
    """大模型助手意图分类（对应 spec 八类职责）。"""

    NATURAL_QUERY = "natural_query"  # 自然语言查询
    EVENT_SUMMARY = "event_summary"  # 事件总结
    SCHEDULE_EXPLANATION = "schedule_explanation"  # 调度方案解释
    RULE_RETRIEVAL = "rule_retrieval"  # 规则检索
    HISTORICAL_CASE = "historical_case"  # 历史案例
    SHIFT_HANDOVER = "shift_handover"  # 交接班摘要
    ROOT_CAUSE_HYPOTHESIS = "root_cause_hypothesis"  # 异常根因假设
    REPORT_GENERATION = "report_generation"  # 报告生成


# ---------- 响应数据结构 ----------


@dataclass
class LLMResponse:
    """大模型助手响应：自然语言内容 + 真实数据来源引用 + 安全不变量标记。

    安全不变量：generated_by_llm 与 not_for_direct_control 在 __post_init__ 中
    被强制为 True，任何尝试置 False 的调用都会被改写，确保输出永不直接控制设备。
    """

    request_id: str
    intent: str
    content: str
    source_refs: list = field(default_factory=list)
    generated_by_llm: bool = True
    not_for_direct_control: bool = True
    confidence: float = 1.0
    caveats: list = field(default_factory=list)
    ts: str = ""

    def __post_init__(self):
        if not self.ts:
            self.ts = now_iso()
        # 强制安全不变量：无论传入何值，输出必须标注为 LLM 生成且不可直接控制
        self.generated_by_llm = True
        self.not_for_direct_control = True

    def to_dict(self):
        return {
            "request_id": self.request_id,
            "intent": self.intent,
            "content": self.content,
            "source_refs": [dict(r) for r in self.source_refs],
            "generated_by_llm": self.generated_by_llm,
            "not_for_direct_control": self.not_for_direct_control,
            "confidence": self.confidence,
            "caveats": list(self.caveats),
            "ts": self.ts,
            "ts_ms": ts_to_ms(self.ts),
        }


# ---------- 内置模板生成器 ----------


class TemplateBackend:
    """内置模板生成器：接收 prompt 字符串，返回基于上下文的模板化响应。

    不实际调用大模型 API；将传入 prompt（由助手方法组装、含真实上下文摘要）包装为
    自然语言模板响应。未来接入真实 LLM 时，可替换为真实 backend（同一 Callable 接口）。
    """

    def __call__(self, prompt: str) -> str:
        if not prompt:
            return "（模板生成：未提供查询内容）"
        # 模板化包装：保留 prompt 中由助手方法组装的真实数据摘要，附加生成来源声明
        return (
            "【本地助手·模板生成】\n" + str(prompt) + "\n（以上内容基于传入上下文生成，未虚构传感器数据或调度结果；"
            "本输出仅供辅助决策，不得直接用于实时控制。）"
        )


# ---------- 通用工具 ----------


def _get(obj, key, default=None):
    """从 dict 或对象取属性（duck-typed，兼容 ScheduleRequest/Candidate 与 dict）。"""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _ref(kind, rid, field_name):
    """构造一条 source_ref（统一格式）。"""
    return {"kind": kind, "id": str(rid), "field": str(field_name)}


def _fmt_num(v, fmt="%.2f"):
    """格式化数值，None 显示为 '-'。"""
    if v is None:
        return "-"
    try:
        return fmt % float(v)
    except (TypeError, ValueError):
        return str(v)


# ---------- 本地大模型助手 ----------

# 通用免责声明（所有输出附加，强化"不直接控制"边界）
_COMMON_CAVEATS = [
    "本输出由本地大模型助手生成，仅供辅助决策，不得直接用于实时设备控制。",
    "调度结果来自结构化算法（Scheduler），大模型仅负责解释，不生成新的调度候选。",
]


class LocalLLMAssistant:
    """本地大模型助手：八类职责的自然语言生成，强制安全不变量。

    核心安全不变量（强制）：
    1. 不调用任何 actuator/execute 接口，不向设备下发控制指令；
    2. 不生成新的 ScheduleRequest，只解释已有的；
    3. 所有引用数据来自传入 context，附 source_ref，不虚构；
    4. 所有输出标注 generated_by_llm=True 与 not_for_direct_control=True；
    5. 调度解释只引用 Scheduler.propose() 已生成的 ScheduleRequest，不生成新候选。
    """

    def __init__(self, llm_backend: Optional[Callable[[str], str]] = None):
        """初始化助手。

        Args:
            llm_backend: 可选的可调用对象 Callable[[str], str]，接收 prompt 字符串
                返回自然语言文本；为 None 时使用内置 TemplateBackend（不调用大模型 API）。
        """
        # 安全不变量：禁止注入具备控制能力的 backend；此处仅接受文本生成 callable
        self._backend = llm_backend if llm_backend is not None else TemplateBackend()
        self._audit_log: list[dict] = []

    # ---- 内部工具 ----

    def _record_audit(self, intent, request_id, source_refs, caveats):
        """记录一条审计日志（每次生成均记录）。"""
        self._audit_log.append(
            {
                "ts": now_iso(),
                "intent": intent,
                "request_id": request_id,
                "source_refs_count": len(source_refs),
                "caveats": list(caveats),
            }
        )

    def _make_response(self, intent_value, content, source_refs, caveats=None, confidence=1.0):
        """统一构造 LLMResponse 并记审计；强制安全不变量。"""
        intent = intent_value.value if isinstance(intent_value, LLMIntent) else str(intent_value)
        request_id = new_id("LLM")
        # 合并通用免责声明与本次特定声明（去重保序）
        merged_caveats = list(_COMMON_CAVEATS)
        for c in caveats or []:
            if c not in merged_caveats:
                merged_caveats.append(c)
        resp = LLMResponse(
            request_id=request_id,
            intent=intent,
            content=content,
            source_refs=[dict(r) for r in source_refs],
            confidence=confidence,
            caveats=merged_caveats,
        )
        self._record_audit(intent, request_id, resp.source_refs, resp.caveats)
        return resp

    def _insufficient_context(self, intent_value, hint):
        """无足够上下文时的统一响应：明确"信息不足"，不虚构数据。"""
        content = self._backend(f"信息不足：{hint}；未提供足够的上下文数据，拒绝虚构。")
        return self._make_response(
            intent_value,
            content,
            [],
            caveats=["信息不足：未提供足够上下文，无法生成基于真实数据的回答。"],
            confidence=0.0,
        )

    # ---- 1. 自然语言查询 ----

    def query(self, question, context):
        """自然语言查询：基于 context（结构化数据字典）回答问题。

        所有引用数据必须带 source_refs；context 为空时返回"信息不足"提示，不虚构。
        """
        context = context or {}
        if not context or not str(question).strip():
            return self._insufficient_context(LLMIntent.NATURAL_QUERY, "自然语言查询缺少问题或上下文")

        # 从 context 抽取真实数据点（不虚构）：persons_state / stations_state / events / metrics
        source_refs = []
        data_lines = []
        persons_state = _get(context, "persons_state", {}) or {}
        for pid, pstate in persons_state.items():
            pstate = pstate or {}
            for fld in (
                "current_load",
                "expected_production_uplift",
                "on_time_probability",
                "safety_risk",
                "battery_percent",
            ):
                if fld in pstate and pstate[fld] is not None:
                    source_refs.append(_ref("person_state", pid, fld))
                    data_lines.append(f"  - 人员 {pid} 的 {fld} = {_fmt_num(pstate[fld])}")
            if "pose" in pstate and pstate["pose"] is not None:
                source_refs.append(_ref("person_state", pid, "pose"))
                data_lines.append(f"  - 人员 {pid} 位置已记录")

        stations_state = _get(context, "stations_state", {}) or {}
        for sid in stations_state.keys():
            source_refs.append(_ref("station_state", sid, "status"))

        metrics = _get(context, "metrics", {}) or {}
        for mk, mv in metrics.items():
            source_refs.append(_ref("metric", "ctx", mk))
            data_lines.append(f"  - 指标 {mk} = {_fmt_num(mv)}")

        events = _get(context, "events", []) or []
        for ev in events:
            eid = _get(ev, "event_id", _get(ev, "id", "?"))
            source_refs.append(_ref("event", eid, "summary"))
            data_lines.append(f"  - 事件 {eid}：{_get(ev, 'message', _get(ev, 'type', ''))}")

        if not source_refs:
            return self._insufficient_context(LLMIntent.NATURAL_QUERY, "上下文中无可引用的真实数据点")

        prompt = "用户问题：{}\n可引用的真实上下文数据：\n{}\n请基于上述真实数据回答，不得虚构。".format(
            str(question), "\n".join(data_lines)
        )
        content = self._backend(prompt)
        return self._make_response(LLMIntent.NATURAL_QUERY, content, source_refs, confidence=0.9)

    # ---- 2. 事件总结 ----

    def summarize_events(self, events, time_window=None):
        """事件总结：输入 events 列表，输出结构化摘要。

        摘要包含：事件总数、按严重级别/类型分组、时间范围；所有事件附 source_ref。
        """
        events = events or []
        if not events:
            return self._insufficient_context(LLMIntent.EVENT_SUMMARY, "事件总结缺少事件列表")

        source_refs = []
        by_severity = {}
        by_type = {}
        ts_list = []
        for ev in events:
            eid = _get(ev, "event_id", _get(ev, "id", new_id("EV")))
            source_refs.append(_ref("event", eid, "summary"))
            sev = _get(ev, "severity", "UNKNOWN")
            etype = _get(ev, "type", _get(ev, "event_type", "unknown"))
            by_severity[sev] = by_severity.get(sev, 0) + 1
            by_type[etype] = by_type.get(etype, 0) + 1
            ets = _get(ev, "ts", _get(ev, "triggered_at", None))
            if ets:
                ts_list.append(ets)

        sev_summary = "、".join(f"{k}×{int(v)}" for k, v in sorted(by_severity.items()))
        type_summary = "、".join(f"{k}×{int(v)}" for k, v in sorted(by_type.items()))
        time_range = ""
        if ts_list:
            time_range = f"（时间范围 {ts_list[0]} ~ {ts_list[-1]}）"
        window_note = ""
        if time_window is not None:
            window_note = f"；统计窗口：{str(time_window)}"

        prompt = (
            f"事件总结{time_range}：\n共 {len(events)} 条事件；"
            f"按严重级别：{sev_summary}；按类型：{type_summary}{window_note}\n"
            "所有事件均来自传入事件列表，未虚构。"
        )
        content = self._backend(prompt)
        return self._make_response(LLMIntent.EVENT_SUMMARY, content, source_refs, confidence=0.95)

    # ---- 3. 调度方案解释（安全不变量：不生成新候选）----

    def explain_schedule(self, schedule_request):
        """调度方案解释：**只能引用已有 ScheduleRequest，不生成新候选**。

        安全不变量：
        - 不调用 Scheduler.propose() 或候选生成器，不新增/删除/修改候选；
        - content 包含触发原因、候选评分排序、各候选理由、推荐方案；
        - 所有引用来自传入 schedule_request（含 candidate.explanation）。
        """
        if schedule_request is None:
            return self._insufficient_context(LLMIntent.SCHEDULE_EXPLANATION, "调度解释缺少 ScheduleRequest")

        rid = _get(schedule_request, "request_id", "?")
        trigger = _get(schedule_request, "trigger", {}) or {}
        task = _get(schedule_request, "task", {}) or {}
        candidates = _get(schedule_request, "candidates", []) or []

        if not candidates:
            return self._insufficient_context(LLMIntent.SCHEDULE_EXPLANATION, f"ScheduleRequest {rid} 无候选可解释")

        # 引用 ScheduleRequest 各字段（不修改原对象，不生成新候选）
        source_refs = [
            _ref("schedule_request", rid, "trigger"),
            _ref("schedule_request", rid, "task"),
            _ref("schedule_request", rid, "candidates"),
            _ref("schedule_request", rid, "ranked_candidate_ids"),
        ]

        # 触发原因
        trigger_lines = []
        for k, v in trigger.items():
            trigger_lines.append(f"  - {k}: {v}")
        if not trigger_lines:
            trigger_lines.append("  - （触发上下文为空）")

        # 候选评分排序 + 各候选理由（引用 candidate.explanation，不重新评分）
        cand_lines = []
        recommended = None
        for idx, cand in enumerate(candidates):
            cid = _get(cand, "candidate_id", "?")
            pid = _get(cand, "person_id", "?")
            did = _get(cand, "device_id", "?")
            passed = _get(cand, "passed", False)
            score = _get(cand, "score", None)
            source_refs.append(_ref("candidate", cid, "explanation"))
            source_refs.append(_ref("candidate", cid, "score"))
            mark = "通过" if passed else "拦截"
            cand_lines.append(
                f"  {int(idx + 1)}. 候选 {cid}（人员 {pid} + 设备 {did}）[{mark}，评分 {_fmt_num(score)}]"
            )
            # 引用候选已有解释（由 Scheduler.explain_candidate 生成），不重新生成
            expl = _get(cand, "explanation", None)
            reasons = _get(expl, "reasons", []) or []
            for r in reasons:
                cand_lines.append(f"     - {r}")
            # 推荐方案：第一个通过的候选（排序已由 Scheduler 完成）
            if recommended is None and passed:
                recommended = (cid, pid, did, score)

        rec_lines = []
        if recommended is not None:
            cid, pid, did, score = recommended
            rec_lines.append(f"  推荐方案：候选 {cid}（人员 {pid} + 设备 {did}），综合评分 {_fmt_num(score)}")
            source_refs.append(_ref("schedule_request", rid, "ranked_candidate_ids"))
        else:
            rec_lines.append("  无通过硬约束的候选，无可推荐方案")

        prompt = (
            f"调度方案解释（ScheduleRequest {rid}）：\n"
            f"触发原因：\n{chr(10).join(trigger_lines)}\n"
            f"任务：{task}\n"
            f"候选评分排序（共 {len(candidates)} 个，引用 Scheduler 已生成结果，"
            f"未重新评分/未生成新候选）：\n{chr(10).join(cand_lines)}\n"
            f"推荐方案：\n{chr(10).join(rec_lines)}\n"
            "本解释仅引用已有 ScheduleRequest，未生成新候选，未触碰设备控制。"
        )
        content = self._backend(prompt)
        return self._make_response(
            LLMIntent.SCHEDULE_EXPLANATION,
            content,
            source_refs,
            caveats=["调度解释仅引用已有 ScheduleRequest，未生成新候选，未修改原请求。"],
            confidence=0.95,
        )

    # ---- 4. 规则检索 ----

    def retrieve_rules(self, query, rule_registry):
        """规则检索：在 rule_registry 中匹配 query 关键词，返回匹配规则与解释。"""
        if rule_registry is None:
            return self._insufficient_context(LLMIntent.RULE_RETRIEVAL, "规则检索缺少规则注册表")
        if not str(query).strip():
            return self._insufficient_context(LLMIntent.RULE_RETRIEVAL, "规则检索缺少查询关键词")

        # 取注册表全部规则（最新版本），duck-typed：rule_registry.all()
        all_rules = []
        if hasattr(rule_registry, "all"):
            all_rules = list(rule_registry.all())
        elif hasattr(rule_registry, "enabled"):
            all_rules = list(rule_registry.enabled())
        elif isinstance(rule_registry, (list, tuple)):
            all_rules = list(rule_registry)

        if not all_rules:
            return self._insufficient_context(LLMIntent.RULE_RETRIEVAL, "规则注册表为空")

        keywords = [w.lower() for w in str(query).split() if w.strip()]
        matched = []
        source_refs = []
        for rule in all_rules:
            rid = _get(rule, "rule_id", "?")
            rver = _get(rule, "rule_version", "?")
            sev = _get(rule, "severity", "")
            # 检索文本：rule_id + severity + config（不虚构规则内容）
            haystack_parts = [str(rid), str(rver), str(sev)]
            config = _get(rule, "config", {}) or {}
            for ck, cv in config.items():
                haystack_parts.append(f"{ck}:{cv}")
            haystack = " ".join(haystack_parts).lower()
            hit = any(kw in haystack for kw in keywords) if keywords else True
            if hit:
                matched.append(rule)
                source_refs.append(_ref("rule", rid, "definition"))
                source_refs.append(_ref("rule", rid, "config"))

        if not matched:
            prompt = f"规则检索：查询 '{query}' 未匹配到任何规则（注册表共 {len(all_rules)} 条）。"
            content = self._backend(prompt)
            return self._make_response(
                LLMIntent.RULE_RETRIEVAL, content, [], caveats=["未匹配到规则；可尝试调整检索关键词。"], confidence=0.5
            )

        match_lines = []
        for rule in matched:
            rid = _get(rule, "rule_id", "?")
            rver = _get(rule, "rule_version", "?")
            sev = _get(rule, "severity", "")
            config = _get(rule, "config", {}) or {}
            cfg_str = ", ".join(f"{k}={v}" for k, v in config.items()) or "(默认)"
            match_lines.append(f"  - {rid} v{rver} [{sev}] 配置: {cfg_str}")

        prompt = ("规则检索：查询 '{}'，注册表共 {} 条，匹配 {} 条：\n{}\n所有规则定义来自规则注册表，未虚构。").format(
            query, len(all_rules), len(matched), "\n".join(match_lines)
        )
        content = self._backend(prompt)
        return self._make_response(LLMIntent.RULE_RETRIEVAL, content, source_refs, confidence=0.9)

    # ---- 5. 历史案例检索 ----

    def find_historical_cases(self, current_scenario, case_database):
        """历史案例检索：基于特征关键词重叠度排序相似案例。"""
        case_database = case_database or []
        if not case_database:
            return self._insufficient_context(LLMIntent.HISTORICAL_CASE, "历史案例库为空")
        if not current_scenario:
            return self._insufficient_context(LLMIntent.HISTORICAL_CASE, "当前场景描述为空")

        # 当前场景特征词集合
        cur_words = set(self._tokenize(current_scenario))

        scored = []
        source_refs = []
        for case in case_database:
            cid = _get(case, "case_id", _get(case, "id", "?"))
            # 案例文本：title + summary + tags（不虚构）
            text_parts = []
            for fld in ("title", "summary", "description", "tags", "scenario"):
                v = _get(case, fld, None)
                if v is not None:
                    text_parts.append(str(v))
            case_text = " ".join(text_parts)
            case_words = set(self._tokenize(case_text))
            # Jaccard 相似度
            if cur_words and case_words:
                inter = len(cur_words & case_words)
                union = len(cur_words | case_words)
                sim = inter / union if union else 0.0
            else:
                sim = 0.0
            scored.append((sim, cid, case, case_text))

        # 按相似度降序排序
        scored.sort(key=lambda x: x[0], reverse=True)

        case_lines = []
        for sim, cid, case, _ in scored:
            source_refs.append(_ref("historical_case", cid, "summary"))
            title = _get(case, "title", _get(case, "summary", cid))
            case_lines.append(f"  - [相似度 {sim:.2f}] {cid}（{title}）")

        prompt = (
            "历史案例检索：当前场景特征词 {} 个，案例库 {} 条，按相似度降序：\n{}\n"
            "所有案例来自案例库，相似度基于关键词重叠计算，未虚构。"
        ).format(len(cur_words), len(case_database), "\n".join(case_lines))
        content = self._backend(prompt)
        return self._make_response(LLMIntent.HISTORICAL_CASE, content, source_refs, confidence=0.85)

    @staticmethod
    def _tokenize(text):
        """简单分词：英文按空格/标点切分，中文按字符切分（纯标准库，无外部分词）。"""
        if text is None:
            return []
        s = str(text).lower()
        # 用空格与常见标点切分；中文连续字符逐字成词（粗粒度匹配）
        import re

        tokens = re.findall(r"[a-z0-9_]+|[\u4e00-\u9fa5]", s)
        return [t for t in tokens if t.strip()]

    # ---- 6. 交接班摘要 ----

    def generate_shift_handover(self, shift_data):
        """交接班摘要：本班次关键事件、当前状态、待办事项、风险提示。"""
        shift_data = shift_data or {}
        if not shift_data:
            return self._insufficient_context(LLMIntent.SHIFT_HANDOVER, "交接班数据为空")

        source_refs = []
        lines = []

        # 关键事件
        events = _get(shift_data, "events", []) or []
        if events:
            lines.append(f"本班次关键事件（共 {len(events)} 条）：")
            for ev in events[:10]:  # 最多列举 10 条
                eid = _get(ev, "event_id", _get(ev, "id", "?"))
                source_refs.append(_ref("event", eid, "summary"))
                lines.append(f"  - {eid}：{_get(ev, 'message', _get(ev, 'type', ''))}")
        else:
            lines.append("本班次无关键事件记录")

        # 当前状态
        current_status = _get(shift_data, "current_status", {}) or {}
        if current_status:
            lines.append("当前状态：")
            for k, v in current_status.items():
                source_refs.append(_ref("shift_status", k, "value"))
                lines.append(f"  - {k}: {v}")
            source_refs.append(_ref("shift_data", "current_status", "value"))
        else:
            lines.append("当前状态：（未提供）")

        # 待办事项
        todos = _get(shift_data, "todos", []) or []
        if todos:
            lines.append(f"待办事项（共 {len(todos)} 项）：")
            for i, todo in enumerate(todos):
                tid = _get(todo, "todo_id", _get(todo, "id", f"todo-{int(i + 1)}"))
                source_refs.append(_ref("todo", tid, "description"))
                lines.append(f"  - {_get(todo, 'description', str(todo))}")
        else:
            lines.append("待办事项：（无）")

        # 风险提示
        risks = _get(shift_data, "risks", []) or []
        if risks:
            lines.append(f"风险提示（共 {len(risks)} 项）：")
            for i, risk in enumerate(risks):
                rid = _get(risk, "risk_id", _get(risk, "id", f"risk-{int(i + 1)}"))
                source_refs.append(_ref("risk", rid, "description"))
                lines.append(f"  - {_get(risk, 'description', str(risk))}")

        shift_id = _get(shift_data, "shift_id", "?")
        source_refs.append(_ref("shift_data", shift_id, "events"))

        prompt = "交接班摘要（班次 {}）：\n{}\n所有内容来自交接班数据，未虚构。".format(shift_id, "\n".join(lines))
        content = self._backend(prompt)
        return self._make_response(LLMIntent.SHIFT_HANDOVER, content, source_refs, confidence=0.9)

    # ---- 7. 异常根因假设 ----

    def hypothesize_root_cause(self, anomaly, context):
        """异常根因假设：返回多个候选假设（按可能性排序），每个附证据引用。

        明确标注"假设，需人工核实"；所有证据来自传入 context，不虚构传感器数据。
        """
        anomaly = anomaly or {}
        context = context or {}
        if not anomaly:
            return self._insufficient_context(LLMIntent.ROOT_CAUSE_HYPOTHESIS, "异常描述为空")

        aid = _get(anomaly, "anomaly_id", _get(anomaly, "id", "?"))
        atype = _get(anomaly, "type", _get(anomaly, "anomaly_type", "unknown"))
        source_refs = [_ref("anomaly", aid, "type")]

        # 从 context 抽取真实证据（不虚构传感器数据）
        events = _get(context, "events", []) or []
        persons_state = _get(context, "persons_state", {}) or {}
        device_state = _get(context, "device_state", {}) or {}
        telemetry = _get(context, "telemetry", {}) or {}

        hypotheses = []

        # 假设 1：设备相关（若 device_state 提供了故障/离线线索）
        device_faults = []
        for did, dstate in device_state.items():
            dstate = dstate or {}
            status = _get(dstate, "status", "")
            if status in ("fault", "offline", "error", "degraded"):
                device_faults.append((did, status))
                source_refs.append(_ref("device_state", did, "status"))
        if device_faults:
            ev_text = "、".join(f"{d}={s}" for d, s in device_faults)
            hypotheses.append((0.8, f"设备异常：检测到 {atype} 状态异常（{ev_text}）", device_faults))

        # 假设 2：人员负荷/疲劳相关（若 persons_state 提供高负荷线索）
        high_load_persons = []
        for pid, pstate in persons_state.items():
            pstate = pstate or {}
            load = _get(pstate, "current_load", None)
            if load is not None:
                try:
                    if float(load) > 0.7:
                        high_load_persons.append((pid, float(load)))
                        source_refs.append(_ref("person_state", pid, "current_load"))
                except (TypeError, ValueError):
                    pass
        if high_load_persons:
            ev_text = "、".join(f"{pid}={load_val:.2f}" for pid, load_val in high_load_persons)
            hypotheses.append(
                (0.6, f"人员高负荷：人员 {ev_text} 累计负荷偏高（{ev_text}），可能引发 {atype}", high_load_persons)
            )

        # 假设 3：近期事件聚集（若 events 提供同类型事件聚集线索）
        same_type_events = []
        for ev in events:
            if _get(ev, "type", "") == atype or atype in str(_get(ev, "type", "")):
                eid = _get(ev, "event_id", _get(ev, "id", "?"))
                same_type_events.append(eid)
                source_refs.append(_ref("event", eid, "type"))
        if len(same_type_events) >= 2:
            hypotheses.append(
                (
                    0.5,
                    f"事件聚集：近期同类事件 {atype} 多次发生（{', '.join(same_type_events)}），疑为系统性根因",
                    same_type_events,
                )
            )

        # 假设 4：遥测异常（若 telemetry 提供超限线索）
        out_of_range = []
        for tk, tv in telemetry.items():
            if isinstance(tv, dict):
                flag = _get(tv, "status", _get(tv, "flag", ""))
                if flag in ("out_of_range", "missing", "conflict"):
                    out_of_range.append((tk, flag))
                    source_refs.append(_ref("telemetry", tk, "status"))
        if out_of_range:
            ev_text = "、".join(f"{t}={f}" for t, f in out_of_range)
            hypotheses.append((0.7, f"传感器异常：遥测项 {ev_text} 异常（{ev_text}）", out_of_range))

        # 无证据时给出默认低置信假设
        if not hypotheses:
            hypotheses.append((0.2, f"证据不足：基于异常类型 {atype} 暂无明确线索，需人工现场核实", []))

        # 按可能性降序排序
        hypotheses.sort(key=lambda x: x[0], reverse=True)

        hypo_lines = []
        for i, (prob, text, _) in enumerate(hypotheses):
            hypo_lines.append(f"  假设 {int(i + 1)}（可能性 {prob:.2f}）：{text}")
        hypo_lines.append("  ⚠ 以上均为假设，需人工核实；大模型不得据此直接控制设备或调整调度。")

        prompt = "异常根因假设（异常 {}，类型 {}）：\n{}\n所有证据来自传入上下文，未虚构传感器数据。".format(
            aid, atype, "\n".join(hypo_lines)
        )
        content = self._backend(prompt)
        return self._make_response(
            LLMIntent.ROOT_CAUSE_HYPOTHESIS,
            content,
            source_refs,
            caveats=[
                "以上为根因假设，需人工核实，不得作为直接控制或处罚依据。",
                "大模型不直接实时控制，不取代调度优化器。",
            ],
            confidence=0.6,
        )

    # ---- 8. 报告生成 ----

    def generate_report(self, report_type, data, period=None):
        """报告生成（日报/周报/事件报告）：输出结构化报告内容。"""
        data = data or {}
        if not data:
            return self._insufficient_context(LLMIntent.REPORT_GENERATION, "报告数据为空")

        rtype = str(report_type or "daily").lower()
        valid_types = {"daily", "weekly", "event"}
        if rtype not in valid_types:
            rtype = "daily"

        source_refs = []
        lines = []

        # 报告头
        period_str = str(period) if period else "（未指定周期）"
        lines.append(
            "报告类型：{} | 周期：{}".format(
                {"daily": "日报", "weekly": "周报", "event": "事件报告"}[rtype], period_str
            )
        )
        source_refs.append(_ref("report", rtype, "period"))

        # 关键指标
        metrics = _get(data, "metrics", {}) or {}
        if metrics:
            lines.append("关键指标：")
            for mk, mv in metrics.items():
                source_refs.append(_ref("metric", rtype, mk))
                lines.append(f"  - {mk}: {_fmt_num(mv)}")
        else:
            lines.append("关键指标：（未提供）")

        # 事件统计
        events = _get(data, "events", []) or []
        if events:
            lines.append(f"事件统计（共 {len(events)} 条）：")
            by_sev = {}
            for ev in events:
                sev = _get(ev, "severity", "UNKNOWN")
                by_sev[sev] = by_sev.get(sev, 0) + 1
                eid = _get(ev, "event_id", _get(ev, "id", "?"))
                source_refs.append(_ref("event", eid, "summary"))
            sev_str = "、".join(f"{k}×{int(v)}" for k, v in sorted(by_sev.items()))
            lines.append(f"  - 按严重级别：{sev_str}")

        # 调度统计（引用已有 ScheduleRequest，不生成新候选）
        schedules = _get(data, "schedule_requests", []) or []
        if schedules:
            lines.append(f"调度统计（共 {len(schedules)} 个请求，引用已有结果，未生成新候选）：")
            confirmed = 0
            executed = 0
            for req in schedules:
                rid = _get(req, "request_id", "?")
                status = _get(req, "status", "?")
                source_refs.append(_ref("schedule_request", rid, "status"))
                if status in ("CONFIRMED", "EXECUTED"):
                    confirmed += 1
                if status == "EXECUTED":
                    executed += 1
            lines.append(f"  - 已确认 {int(confirmed)} / 已执行 {int(executed)} / 总计 {len(schedules)}")

        # 总结建议（辅助性，不直接控制）
        summary = _get(data, "summary", "")
        if summary:
            source_refs.append(_ref("report", rtype, "summary"))
            lines.append(f"总结：{summary}")

        prompt = "{}（{}）：\n{}\n所有数据来自传入报告数据，未虚构；本报告仅供辅助决策，不得直接用于控制。".format(
            {"daily": "生产日报", "weekly": "生产周报", "event": "事件报告"}[rtype], period_str, "\n".join(lines)
        )
        content = self._backend(prompt)
        return self._make_response(LLMIntent.REPORT_GENERATION, content, source_refs, confidence=0.9)

    # ---- 审计日志 ----

    def audit_log(self):
        """返回审计日志副本（每次生成的 ts/intent/request_id/source_refs_count/caveats）。"""
        return [dict(entry) for entry in self._audit_log]
