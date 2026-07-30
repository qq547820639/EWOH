"""负荷与疲劳趋势评分单元测试（算法第三阶段：负荷与疲劳趋势评分）。

覆盖 spec「算法分阶段实施」第三阶段关键能力（只做趋势评分，不做医学诊断）：
- 低负荷班次 -> LOW 等级，STABLE/FALLING，无高负荷原因。
- 连续弯腰 + 多次搬运 -> HIGH 等级，RISING，原因提及弯腰/搬运/基线，建议含恢复。
- 个体基线偏差计算正确。
- format_report 产出 4 行中文文本块。
- is_medical 恒为 False（安全不变量）。
- 恢复时间建议随负荷等级递增。

纯 Python 标准库（unittest）；从 /workspace 运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_fatigue -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.inference import ms_to_ts, ts_to_ms
from edge_platform.inference.fatigue import (
    LoadSample, FatigueReport, LoadLevel, TrendDirection,
    FatigueScorer, format_report, recovery_minutes,
    MODEL_VERSION, FORBIDDEN_MEDICAL_TERMS,
)

BASE_TS = ts_to_ms("2026-07-31T00:00:00.000+00:00")  # 固定时间起点，保证测试可重复


def ts(minute_offset):
    """相对基准的 ISO 时间戳（分钟偏移）。"""
    return ms_to_ts(BASE_TS + int(minute_offset) * 60 * 1000)


def sample(minute, action, load, assist=0.0, duration=60.0):
    """快速构造 LoadSample（默认 60 秒窗口）。"""
    return LoadSample(ts=ts(minute), action=action, load_level=load,
                      assist_level=assist, duration_sec=duration)


# ---------- 1. 低负荷班次 ----------

class LowLoadShiftTest(unittest.TestCase):
    def test_low_load_is_low_and_stable(self):
        scorer = FatigueScorer()
        # 30 分钟低负荷：行走+站立，负荷恒定低
        for i in range(30):
            scorer.ingest("P1", sample(i, "walk" if i % 2 == 0 else "stand",
                                        load=0.2, assist=0.1))
        report = scorer.score("P1", horizon_min=30)
        self.assertEqual(report.current_load_level, "LOW")
        self.assertLess(report.current_load_score, 0.4)
        self.assertIn(report.trend_30min, ("STABLE", "FALLING"))
        # 无高负荷相关原因（不提及弯腰/搬运/基线/助力不足）
        for cause in report.main_causes:
            for kw in ("弯腰", "搬运", "基线", "助力不足"):
                self.assertNotIn(kw, cause)
        self.assertNotIn("恢复", report.recommendation)  # 低负荷不建议恢复
        self.assertEqual(report.model_version, MODEL_VERSION)

    def test_empty_state_returns_low_zero_confidence(self):
        scorer = FatigueScorer()
        report = scorer.score("NOBODY", horizon_min=30)
        self.assertEqual(report.current_load_level, "LOW")
        self.assertEqual(report.confidence, 0.0)
        self.assertFalse(report.is_medical)


# ---------- 2. 连续弯腰 + 多次搬运 ----------

class HighLoadBendingLiftsTest(unittest.TestCase):
    def _build(self):
        scorer = FatigueScorer()
        # 参考班次（基线）：少量搬运、低负荷、无弯腰
        baseline_samples = [sample(i, "walk", load=0.35, assist=0.3)
                            for i in range(10)]
        baseline_samples += [sample(10 + i, "lift", load=0.5, assist=0.3)
                             for i in range(2)]  # 基线搬运 2 次
        scorer.update_baseline("P2", baseline_samples)

        # 当前班次：负荷逐步上升 0.5 -> 0.95，混入连续弯腰与多次搬运
        n = 30
        for i in range(n):
            load = 0.5 + 0.45 * (i / (n - 1))  # 30 分钟内线性上升
            if i % 3 == 0:
                action = "bend"
            elif i % 3 == 1:
                action = "lift"
            else:
                action = "carry"
            scorer.ingest("P2", sample(i, action, load=load, assist=0.5,
                                        duration=60.0))
        return scorer

    def test_high_load_rising_with_causes(self):
        scorer = self._build()
        report = scorer.score("P2", horizon_min=30)
        self.assertEqual(report.current_load_level, "HIGH")
        self.assertGreater(report.current_load_score, 0.7)
        self.assertEqual(report.trend_30min, "RISING")
        self.assertGreater(report.trend_per_min, 0.0)

        joined = "、".join(report.main_causes)
        # 原因必须提及弯腰、搬运、基线（引用真实计算值）
        self.assertIn("弯腰", joined)
        self.assertIn("搬运", joined)
        self.assertIn("基线", joined)
        # 建议含恢复
        self.assertIn("恢复", report.recommendation)

    def test_causes_reference_real_numbers(self):
        # 原因字符串必须含真实数值（秒数/次数/基线值），不得仅泛泛而谈
        scorer = self._build()
        report = scorer.score("P2", horizon_min=30)
        self.assertTrue(len(report.main_causes) >= 2)
        # 弯腰原因含数字（秒）；搬运原因含次数数字
        bend_cause = [c for c in report.main_causes if "弯腰" in c]
        lift_cause = [c for c in report.main_causes if "搬运" in c]
        self.assertTrue(bend_cause and any(ch.isdigit() for ch in bend_cause[0]))
        self.assertTrue(lift_cause and any(ch.isdigit() for ch in lift_cause[0]))


# ---------- 3. 个体基线偏差 ----------

class BaselineDeviationTest(unittest.TestCase):
    def test_deviation_above_baseline(self):
        scorer = FatigueScorer()
        # 基线：10 条样本，load=0.5，duration=60s -> baseline_cumulative=300, duration=600
        scorer.update_baseline("P3", [sample(i, "walk", load=0.5, duration=60.0)
                                      for i in range(10)])
        # 当前：10 条样本，load=0.7，duration=60s -> cumulative=420, duration=600
        for i in range(10):
            scorer.ingest("P3", sample(i, "walk", load=0.7, duration=60.0))
        report = scorer.score("P3", horizon_min=30)
        # expected = 300 * (600/600) = 300；deviation = 420 - 300 = 120
        self.assertAlmostEqual(report.individual_baseline, 300.0, places=4)
        self.assertAlmostEqual(report.deviation_from_baseline, 120.0, places=4)

    def test_deviation_zero_when_no_baseline(self):
        scorer = FatigueScorer()
        for i in range(10):
            scorer.ingest("P4", sample(i, "walk", load=0.7, duration=60.0))
        report = scorer.score("P4", horizon_min=30)
        self.assertEqual(report.individual_baseline, 0.0)
        self.assertEqual(report.deviation_from_baseline, 0.0)


# ---------- 4. format_report 4 行中文 ----------

class FormatReportTest(unittest.TestCase):
    def test_four_line_chinese_block(self):
        report = FatigueReport(
            person_id="P5",
            generated_at="2026-07-31T00:30:00.000+00:00",
            current_load_level="MEDIUM",
            current_load_score=0.55,
            trend_30min="RISING",
            trend_per_min=0.01,
            main_causes=["连续弯腰时间增加（180 秒）", "搬运次数 15 高于个人基线 2"],
            recommendation="负荷上升，建议适时安排短时恢复（建议恢复 8 分钟）",
            individual_baseline=300.0,
            deviation_from_baseline=120.0,
            confidence=0.9,
            model_version=MODEL_VERSION,
            is_medical=False,
        )
        text = format_report(report)
        lines = text.split("\n")
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[0].startswith("当前负荷："))
        self.assertIn("中", lines[0])
        self.assertTrue(lines[1].startswith("30分钟趋势："))
        self.assertIn("上升", lines[1])
        self.assertTrue(lines[2].startswith("主要原因："))
        self.assertIn("连续弯腰时间增加", lines[2])
        self.assertIn("搬运次数", lines[2])
        self.assertTrue(lines[3].startswith("建议："))
        # 不得出现任何医学禁用词
        for term in FORBIDDEN_MEDICAL_TERMS:
            self.assertNotIn(term, text)

    def test_format_empty_causes(self):
        report = FatigueReport(
            person_id="P6", generated_at="2026-07-31T00:30:00.000+00:00",
            current_load_level="LOW", current_load_score=0.1,
            trend_30min="STABLE", trend_per_min=0.0,
            main_causes=[], recommendation="负荷正常，保持当前节奏",
            individual_baseline=0.0, deviation_from_baseline=0.0,
            confidence=0.8, model_version=MODEL_VERSION, is_medical=False,
        )
        text = format_report(report)
        self.assertIn("无明显异常因素", text)


# ---------- 5. is_medical 安全不变量 ----------

class IsMedicalInvariantTest(unittest.TestCase):
    def test_is_medical_always_false_across_scenarios(self):
        scenarios = []
        # 低负荷
        s1 = FatigueScorer()
        for i in range(20):
            s1.ingest("A", sample(i, "idle", load=0.1, assist=0.0))
        scenarios.append(s1.score("A"))
        # 高负荷（弯腰+搬运），含基线
        s2 = FatigueScorer()
        s2.update_baseline("B", [sample(i, "walk", load=0.3) for i in range(5)])
        for i in range(20):
            s2.ingest("B", sample(i, "bend" if i % 2 else "lift",
                                   load=0.6 + 0.3 * (i / 19), assist=0.4))
        scenarios.append(s2.score("B"))
        # 无样本
        scenarios.append(FatigueScorer().score("C"))
        for r in scenarios:
            self.assertFalse(r.is_medical, "is_medical 必须恒为 False")
            # 同时校验文本不出现禁用医学表述
            blob = "".join(r.main_causes) + r.recommendation
            for term in FORBIDDEN_MEDICAL_TERMS:
                self.assertNotIn(term, blob)

    def test_load_level_enum_thresholds(self):
        self.assertEqual(LoadLevel.from_score(0.0), LoadLevel.LOW)
        self.assertEqual(LoadLevel.from_score(0.39), LoadLevel.LOW)
        self.assertEqual(LoadLevel.from_score(0.4), LoadLevel.MEDIUM)
        self.assertEqual(LoadLevel.from_score(0.7), LoadLevel.MEDIUM)
        self.assertEqual(LoadLevel.from_score(0.71), LoadLevel.HIGH)
        self.assertEqual(LoadLevel.from_score(1.0), LoadLevel.HIGH)


# ---------- 6. 恢复时间随负荷递增 ----------

class RecoveryTimeTest(unittest.TestCase):
    def test_recovery_minutes_monotonic_with_load(self):
        low = recovery_minutes(0.2)
        mid = recovery_minutes(0.5)
        high = recovery_minutes(0.9)
        self.assertLess(low, mid)
        self.assertLess(mid, high)

    def test_recovery_minutes_increases_with_deviation(self):
        # 同一负荷等级下，基线偏差越大恢复时间越长
        base = recovery_minutes(0.8, 0.0)
        more = recovery_minutes(0.8, 200.0)
        self.assertGreaterEqual(more, base)

    def test_high_load_report_recovery_in_recommendation(self):
        scorer = FatigueScorer()
        scorer.update_baseline("R", [sample(i, "walk", load=0.3) for i in range(5)])
        # 高负荷：弯腰 + 搬运交替，负荷持续高位
        for i in range(20):
            scorer.ingest("R", sample(i, "bend" if i % 2 == 0 else "lift",
                                       load=0.9, assist=0.3))
        report = scorer.score("R", horizon_min=30)
        self.assertEqual(report.current_load_level, "HIGH")
        self.assertIn("恢复", report.recommendation)


# ---------- 7. 额外：助力收益与累计负荷积分 ----------

class ComponentsTest(unittest.TestCase):
    def test_shift_cumulative_reflects_load_integral(self):
        # 累计负荷积分应跨整个班次累加（不被 1 小时环形缓冲裁剪影响）
        scorer = FatigueScorer()
        # 2 小时高负荷（每分钟 1 条，load=0.6，duration=60s）
        for i in range(120):
            scorer.ingest("S", sample(i, "lift", load=0.6, assist=0.3,
                                       duration=60.0))
        report = scorer.score("S", horizon_min=30)
        # 累计 = 120 * 0.6 * 60 = 4320；个体基线未设置 -> deviation=0
        self.assertEqual(report.individual_baseline, 0.0)
        self.assertEqual(report.deviation_from_baseline, 0.0)
        # 累计负荷高，等级至少 MEDIUM
        self.assertIn(report.current_load_level, ("MEDIUM", "HIGH"))

    def test_trend_falling_when_load_decreases(self):
        scorer = FatigueScorer()
        n = 30
        for i in range(n):
            load = 0.9 - 0.7 * (i / (n - 1))  # 0.9 -> 0.2 下降
            scorer.ingest("F", sample(i, "walk", load=load, assist=0.2))
        report = scorer.score("F", horizon_min=30)
        self.assertEqual(report.trend_30min, "FALLING")
        self.assertLess(report.trend_per_min, 0.0)

    def test_confidence_high_with_dense_recent_samples(self):
        scorer = FatigueScorer()
        for i in range(30):
            scorer.ingest("D", sample(i, "walk", load=0.3, assist=0.1))
        report = scorer.score("D", horizon_min=30)
        self.assertGreater(report.confidence, 0.8)


if __name__ == "__main__":
    unittest.main()
