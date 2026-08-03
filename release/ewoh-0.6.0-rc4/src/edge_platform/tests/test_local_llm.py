"""本地大模型助手单元测试（spec Task 27）：八类职责 + 安全不变量。

覆盖 spec「本地大模型角色约束」验收要求：
- query/summarize_events/explain_schedule/retrieve_rules/find_historical_cases/
  generate_shift_handover/hypothesize_root_cause/generate_report 结构与内容正确；
- 安全不变量：所有输出含 generated_by_llm=True 与 not_for_direct_control=True；
- explain_schedule 不生成新候选、不修改原 ScheduleRequest；
- 无 context 时返回"信息不足"提示；
- TemplateBackend 默认工作，可注入自定义 backend；
- 审计日志记录完整。

纯 Python 标准库 unittest；运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_local_llm -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.assistant import (
    LLMIntent,
    LLMResponse,
    LocalLLMAssistant,
    TemplateBackend,
)
from edge_platform.inference import RuleRegistry
from edge_platform.inference.spatial_rules import (
    HighLoadDurationRule,
    PostureThresholdRule,
    ZoneViolationRule,
)
from edge_platform.scheduler import (
    HardConstraints,
    Scheduler,
)
from edge_platform.spatial import Pose

# ---------- 公共夹具 ----------


def _make_assistant(backend=None):
    return LocalLLMAssistant(llm_backend=backend)


def _make_schedule_request():
    """构造一个真实的 ScheduleRequest（经 Scheduler.propose()，含候选与解释）。"""
    constraints = HardConstraints(
        skills_registry={"p1": {"lifting"}, "p2": set()},
        station_auth={"p1": {"s1"}},
    )
    sched = Scheduler(constraints)
    task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1", "zone_id": "z1"}
    persons = [{"person_id": "p1"}, {"person_id": "p2"}]
    devices = [{"device_id": "d1", "model": "exoA"}]
    ctx = {
        "persons_state": {
            "p1": {
                "current_load": 0.4,
                "expected_production_uplift": 0.5,
                "on_time_probability": 0.8,
                "pose": Pose(x=0.0, y=0.0),
            },
        },
        "stations_state": {"s1": {"pose": Pose(x=3.0, y=4.0)}},
    }
    return sched.propose(task, persons, devices, ctx)


def _make_rule_registry():
    reg = RuleRegistry()
    reg.register(PostureThresholdRule(config={"trunk_pitch_deg": 45.0, "sustained_sec": 5}))
    reg.register(HighLoadDurationRule(config={"sustained_sec": 10}))
    reg.register(ZoneViolationRule())
    return reg


# ---------- 1. 自然语言查询 ----------


class QueryTest(unittest.TestCase):
    def test_query_returns_correct_structure(self):
        """query 返回正确结构（LLMResponse 全字段）。"""
        ast = _make_assistant()
        ctx = {"persons_state": {"p1": {"current_load": 0.4}}}
        resp = ast.query("p1 当前负荷？", ctx)
        self.assertIsInstance(resp, LLMResponse)
        self.assertTrue(resp.request_id.startswith("LLM-"))
        self.assertEqual(resp.intent, LLMIntent.NATURAL_QUERY.value)
        self.assertIsInstance(resp.content, str)
        self.assertTrue(resp.content)
        self.assertIsInstance(resp.source_refs, list)
        self.assertTrue(resp.ts)
        self.assertIsInstance(resp.caveats, list)

    def test_query_source_refs_complete(self):
        """query 的 source_refs 完整引用上下文真实数据点。"""
        ast = _make_assistant()
        ctx = {
            "persons_state": {
                "p1": {"current_load": 0.4, "expected_production_uplift": 0.5},
            },
            "stations_state": {"s1": {"status": "ok"}},
            "metrics": {"throughput": 120},
            "events": [{"event_id": "EV-1", "message": "test"}],
        }
        resp = ast.query("查询状态", ctx)
        kinds = {r["kind"] for r in resp.source_refs}
        self.assertIn("person_state", kinds)
        self.assertIn("station_state", kinds)
        self.assertIn("metric", kinds)
        self.assertIn("event", kinds)
        # 每条 source_ref 含 kind/id/field 三字段
        for r in resp.source_refs:
            self.assertEqual({"kind", "id", "field"}, set(r.keys()))

    def test_query_safety_flags(self):
        """query 输出含 generated_by_llm=True 与 not_for_direct_control=True。"""
        ast = _make_assistant()
        ctx = {"persons_state": {"p1": {"current_load": 0.4}}}
        resp = ast.query("查询", ctx)
        self.assertTrue(resp.generated_by_llm)
        self.assertTrue(resp.not_for_direct_control)

    def test_query_content_contains_real_data(self):
        """query 内容引用上下文真实数据（不虚构）。"""
        ast = _make_assistant()
        ctx = {"persons_state": {"p1": {"current_load": 0.42}}}
        resp = ast.query("p1 负荷", ctx)
        self.assertIn("0.42", resp.content)
        self.assertIn("p1", resp.content)


# ---------- 2. 事件总结 ----------


class SummarizeEventsTest(unittest.TestCase):
    def test_summarize_events_content_correct(self):
        """summarize_events 摘要内容正确（总数/严重级别/类型分组）。"""
        ast = _make_assistant()
        events = [
            {
                "event_id": "E1",
                "severity": "L1",
                "type": "posture",
                "ts": "2026-07-31T01:00:00.000+00:00",
                "message": "前倾",
            },
            {
                "event_id": "E2",
                "severity": "L2",
                "type": "load",
                "ts": "2026-07-31T02:00:00.000+00:00",
                "message": "高负荷",
            },
            {
                "event_id": "E3",
                "severity": "L1",
                "type": "posture",
                "ts": "2026-07-31T03:00:00.000+00:00",
                "message": "前倾",
            },
        ]
        resp = ast.summarize_events(events, time_window="2026-07-31")
        self.assertEqual(resp.intent, LLMIntent.EVENT_SUMMARY.value)
        self.assertIn("3", resp.content)  # 共 3 条
        self.assertIn("L1", resp.content)
        self.assertIn("L2", resp.content)
        self.assertIn("posture", resp.content)
        # 每条事件都被引用
        self.assertEqual(len(resp.source_refs), 3)
        ids = {r["id"] for r in resp.source_refs}
        self.assertEqual(ids, {"E1", "E2", "E3"})


# ---------- 3. 调度方案解释（安全不变量重点）----------


class ExplainScheduleTest(unittest.TestCase):
    def test_explain_schedule_no_new_candidates(self):
        """explain_schedule 不生成新候选（candidates 数量不变）。"""
        ast = _make_assistant()
        req = _make_schedule_request()
        count_before = len(req.candidates)
        ids_before = [c.candidate_id for c in req.candidates]
        resp = ast.explain_schedule(req)
        # 解释后候选数量不变
        self.assertEqual(len(req.candidates), count_before)
        # 候选 id 列表不变（顺序与内容均不变）
        self.assertEqual([c.candidate_id for c in req.candidates], ids_before)
        # 解释内容引用了候选
        self.assertTrue(resp.source_refs)

    def test_explain_schedule_references_schedule_request(self):
        """explain_schedule 引用已有 ScheduleRequest（source_refs 含 schedule_request）。"""
        ast = _make_assistant()
        req = _make_schedule_request()
        resp = ast.explain_schedule(req)
        sched_refs = [r for r in resp.source_refs if r["kind"] == "schedule_request"]
        self.assertTrue(sched_refs)
        # 引用的 id 等于原 ScheduleRequest 的 request_id
        self.assertTrue(all(r["id"] == req.request_id for r in sched_refs))
        # 引用 candidate 的 explanation/score
        cand_refs = [r for r in resp.source_refs if r["kind"] == "candidate"]
        self.assertTrue(cand_refs)
        # content 含触发原因、推荐方案
        self.assertIn(req.request_id, resp.content)
        self.assertIn("推荐方案", resp.content)

    def test_explain_schedule_does_not_modify_original(self):
        """安全不变量：explain_schedule 不修改原 ScheduleRequest（对象身份与字段不变）。"""
        ast = _make_assistant()
        req = _make_schedule_request()
        candidates_obj_before = req.candidates
        status_before = req.status
        ranked_before = list(req.ranked_candidate_ids)
        trigger_before = dict(req.trigger)
        ast.explain_schedule(req)
        # 同一对象未被替换
        self.assertIs(req.candidates, candidates_obj_before)
        # 字段未被修改
        self.assertEqual(req.status, status_before)
        self.assertEqual(req.ranked_candidate_ids, ranked_before)
        self.assertEqual(req.trigger, trigger_before)

    def test_explain_schedule_uses_candidate_explanation(self):
        """explain_schedule 调用候选已有 explanation（Scheduler.explain_candidate 生成）。"""
        ast = _make_assistant()
        req = _make_schedule_request()
        # 找到通过候选，其 explanation.reasons 应被引用到 content
        passed = [c for c in req.candidates if c.passed]
        self.assertTrue(passed)
        resp = ast.explain_schedule(req)
        # 通过候选的评分应出现在解释内容中
        self.assertTrue(any(str(c.candidate_id) in resp.content for c in passed))


# ---------- 4. 规则检索 ----------


class RetrieveRulesTest(unittest.TestCase):
    def test_retrieve_rules_returns_matches(self):
        """retrieve_rules 返回匹配规则（关键词命中 rule_id）。"""
        ast = _make_assistant()
        reg = _make_rule_registry()
        resp = ast.retrieve_rules("POSTURE", reg)
        self.assertEqual(resp.intent, LLMIntent.RULE_RETRIEVAL.value)
        # POSTURE_THRESHOLD 命中
        self.assertIn("POSTURE_THRESHOLD", resp.content)
        rule_refs = [r for r in resp.source_refs if r["kind"] == "rule"]
        self.assertTrue(rule_refs)
        ids = {r["id"] for r in rule_refs}
        self.assertIn("POSTURE_THRESHOLD", ids)


# ---------- 5. 历史案例 ----------


class HistoricalCasesTest(unittest.TestCase):
    def test_find_historical_cases_similarity_sort(self):
        """find_historical_cases 相似度排序正确（高相似在前）。"""
        ast = _make_assistant()
        cases = [
            {"case_id": "C1", "title": "外骨骼高负荷事件", "summary": "人员高负荷 搬运 持续超限"},
            {"case_id": "C2", "title": "无关案例", "summary": "网络波动 设备离线"},
            {"case_id": "C3", "title": "高负荷搬运", "summary": "人员高负荷 搬运"},
        ]
        resp = ast.find_historical_cases("人员高负荷 搬运", cases)
        self.assertEqual(resp.intent, LLMIntent.HISTORICAL_CASE.value)
        # C3 与 C1 应排在 C2 之前（关键词重叠更多）
        idx_c2 = resp.content.find("C2")
        idx_c1 = resp.content.find("C1")
        idx_c3 = resp.content.find("C3")
        self.assertLess(idx_c3, idx_c2)
        self.assertLess(idx_c1, idx_c2)
        # 所有案例均被引用
        case_refs = [r for r in resp.source_refs if r["kind"] == "historical_case"]
        self.assertEqual(len(case_refs), 3)


# ---------- 6. 交接班摘要 ----------


class ShiftHandoverTest(unittest.TestCase):
    def test_generate_shift_handover_contains_required_fields(self):
        """generate_shift_handover 包含关键事件/当前状态/待办/风险提示。"""
        ast = _make_assistant()
        shift_data = {
            "shift_id": "SHIFT-A",
            "events": [{"event_id": "E1", "message": "前倾超限"}],
            "current_status": {"on_duty": 5, "stations_active": 3},
            "todos": [{"todo_id": "T1", "description": "复核 p1 排班"}],
            "risks": [{"risk_id": "R1", "description": "p2 技能缺口"}],
        }
        resp = ast.generate_shift_handover(shift_data)
        self.assertEqual(resp.intent, LLMIntent.SHIFT_HANDOVER.value)
        self.assertIn("关键事件", resp.content)
        self.assertIn("当前状态", resp.content)
        self.assertIn("待办事项", resp.content)
        self.assertIn("风险提示", resp.content)
        self.assertIn("SHIFT-A", resp.content)
        self.assertIn("复核 p1 排班", resp.content)


# ---------- 7. 异常根因假设 ----------


class RootCauseHypothesisTest(unittest.TestCase):
    def test_hypothesize_root_cause_multiple_hypotheses_with_evidence(self):
        """hypothesize_root_cause 返回多个假设、附证据、按可能性排序。"""
        ast = _make_assistant()
        anomaly = {"anomaly_id": "AN-1", "type": "load_spike"}
        context = {
            "device_state": {"d1": {"status": "fault"}},
            "persons_state": {"p1": {"current_load": 0.9}},
            "telemetry": {"torque": {"status": "out_of_range"}},
            "events": [
                {"event_id": "E1", "type": "load_spike"},
                {"event_id": "E2", "type": "load_spike"},
            ],
        }
        resp = ast.hypothesize_root_cause(anomaly, context)
        self.assertEqual(resp.intent, LLMIntent.ROOT_CAUSE_HYPOTHESIS.value)
        # 多个假设
        self.assertGreaterEqual(resp.content.count("假设"), 2)
        # 按可能性排序：0.8（设备）应出现在 0.6（人员）之前
        self.assertLess(resp.content.find("0.80"), resp.content.find("0.60"))
        # 附证据引用（device_state/person_state/telemetry/event）
        kinds = {r["kind"] for r in resp.source_refs}
        self.assertIn("device_state", kinds)
        self.assertIn("person_state", kinds)

    def test_hypothesize_root_cause_marks_human_verification(self):
        """hypothesize_root_cause 标注"需人工核实"。"""
        ast = _make_assistant()
        anomaly = {"anomaly_id": "AN-2", "type": "posture"}
        resp = ast.hypothesize_root_cause(anomaly, {"events": []})
        # content 或 caveats 含"需人工核实"
        combined = resp.content + " ".join(resp.caveats)
        self.assertIn("需人工核实", combined)


# ---------- 8. 报告生成 ----------


class GenerateReportTest(unittest.TestCase):
    def test_generate_report_structured_output(self):
        """generate_report 输出结构化报告（含报告类型/指标/事件/调度统计）。"""
        ast = _make_assistant()
        data = {
            "metrics": {"throughput": 100, "defect_rate": 0.02},
            "events": [{"event_id": "E1", "severity": "L1"}, {"event_id": "E2", "severity": "L2"}],
            "schedule_requests": [
                {"request_id": "REQ-1", "status": "CONFIRMED"},
                {"request_id": "REQ-2", "status": "EXECUTED"},
                {"request_id": "REQ-3", "status": "SHADOW"},
            ],
            "summary": "本日生产平稳",
        }
        resp = ast.generate_report("daily", data, period="2026-07-31")
        self.assertEqual(resp.intent, LLMIntent.REPORT_GENERATION.value)
        self.assertIn("日报", resp.content)
        self.assertIn("2026-07-31", resp.content)
        self.assertIn("throughput", resp.content)
        self.assertIn("100", resp.content)
        self.assertIn("调度统计", resp.content)
        self.assertIn("已执行", resp.content)
        self.assertIn("本日生产平稳", resp.content)


# ---------- 审计日志 ----------


class AuditLogTest(unittest.TestCase):
    def test_audit_log_records_all_calls(self):
        """audit_log 记录完整（每次生成一条，含 ts/intent/request_id/source_refs_count/caveats）。"""
        ast = _make_assistant()
        ast.query("q1", {"persons_state": {"p1": {"current_load": 0.4}}})
        ast.summarize_events([{"event_id": "E1", "severity": "L1", "type": "x"}])
        log = ast.audit_log()
        self.assertEqual(len(log), 2)
        for entry in log:
            self.assertIn("ts", entry)
            self.assertIn("intent", entry)
            self.assertIn("request_id", entry)
            self.assertIn("source_refs_count", entry)
            self.assertIn("caveats", entry)
        intents = [e["intent"] for e in log]
        self.assertEqual(intents, [LLMIntent.NATURAL_QUERY.value, LLMIntent.EVENT_SUMMARY.value])
        # audit_log 返回副本，不影响内部状态
        log.clear()
        self.assertEqual(len(ast.audit_log()), 2)


# ---------- 模板生成器与自定义 backend ----------


class TemplateBackendTest(unittest.TestCase):
    def test_template_backend_default_works(self):
        """TemplateBackend 默认工作（不调用大模型 API，返回非空模板响应）。"""
        ast = _make_assistant()  # backend=None → TemplateBackend
        resp = ast.query("查询", {"persons_state": {"p1": {"current_load": 0.4}}})
        self.assertIsInstance(resp, LLMResponse)
        self.assertIn("本地助手·模板生成", resp.content)
        # 直接调用 TemplateBackend 亦可
        out = TemplateBackend()("测试 prompt")
        self.assertIsInstance(out, str)
        self.assertTrue(out)

    def test_custom_backend_injectable(self):
        """可注入自定义 backend（Callable[[str], str]）。"""
        calls = []

        def fake_backend(prompt):
            calls.append(prompt)
            return "FAKE_LLM_RESPONSE"

        ast = _make_assistant(backend=fake_backend)
        resp = ast.query("查询", {"persons_state": {"p1": {"current_load": 0.4}}})
        self.assertEqual(resp.content, "FAKE_LLM_RESPONSE")
        self.assertTrue(calls)  # backend 被调用
        # 安全不变量仍生效
        self.assertTrue(resp.generated_by_llm)
        self.assertTrue(resp.not_for_direct_control)


# ---------- 安全不变量综合测试 ----------


class SafetyInvariantTest(unittest.TestCase):
    def test_all_outputs_carry_safety_flags(self):
        """安全不变量：所有八类输出含 generated_by_llm 与 not_for_direct_control=True。"""
        ast = _make_assistant()
        req = _make_schedule_request()
        reg = _make_rule_registry()
        responses = [
            ast.query("q", {"persons_state": {"p1": {"current_load": 0.4}}}),
            ast.summarize_events([{"event_id": "E1", "severity": "L1", "type": "x"}]),
            ast.explain_schedule(req),
            ast.retrieve_rules("POSTURE", reg),
            ast.find_historical_cases("高负荷", [{"case_id": "C1", "title": "高负荷"}]),
            ast.generate_shift_handover({"shift_id": "S1", "events": []}),
            ast.hypothesize_root_cause({"anomaly_id": "A1", "type": "x"}, {}),
            ast.generate_report("daily", {"metrics": {"a": 1}}),
        ]
        for resp in responses:
            self.assertTrue(resp.generated_by_llm, f"intent={resp.intent} 缺少 generated_by_llm")
            self.assertTrue(resp.not_for_direct_control, f"intent={resp.intent} 缺少 not_for_direct_control")
            # 所有响应都附免责声明
            self.assertTrue(resp.caveats)

    def test_response_forces_safety_flags_even_if_false(self):
        """LLMResponse 强制安全不变量：即便传入 False 也被改写为 True。"""
        resp = LLMResponse(
            request_id="LLM-test",
            intent="natural_query",
            content="x",
            generated_by_llm=False,
            not_for_direct_control=False,
        )
        self.assertTrue(resp.generated_by_llm)
        self.assertTrue(resp.not_for_direct_control)

    def test_no_context_returns_insufficient_prompt(self):
        """无 context 时返回"信息不足"提示（不虚构数据）。"""
        ast = _make_assistant()
        # query 无 context
        resp = ast.query("查询", {})
        self.assertIn("信息不足", resp.content)
        self.assertEqual(resp.source_refs, [])
        # query 无问题
        resp2 = ast.query("", {"persons_state": {"p1": {"current_load": 0.4}}})
        self.assertIn("信息不足", resp2.content)
        # summarize_events 空列表
        resp3 = ast.summarize_events([])
        self.assertIn("信息不足", resp3.content)
        # explain_schedule None
        resp4 = ast.explain_schedule(None)
        self.assertIn("信息不足", resp4.content)


if __name__ == "__main__":
    unittest.main()
