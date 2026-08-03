"""空间与上下文感知规则单元测试（算法第一阶段：规则与统计模型）。

覆盖 spec「算法分阶段实施」第一阶段关键规则与版本化注册表：
- PostureThresholdRule: 持续高前倾角触发；短暂尖峰不触发。
- BatteryPredictionRule: 高放电速率 + 低电量 → 预测近期触底。
- ZoneViolationRule: 人员位于禁区 bbox 内 → 触发；位于外 → 不触发。
- CumulativeLoadIntegralRule: 累计负荷积分跨阈值触发。
- RuleRegistry: 注册两条规则 evaluate_all 返回结果；版本历史保留。

纯 Python 标准库（unittest）；从 /workspace 运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_spatial_rules -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.inference import ms_to_ts
from edge_platform.inference.rule_registry import RuleRegistry
from edge_platform.inference.spatial_rules import (
    ActionCountRule,
    BatteryPredictionRule,
    CumulativeLoadIntegralRule,
    HighLoadDurationRule,
    OfflineDetectionRule,
    PostureThresholdRule,
    RuleFinding,
    SensorConflictRule,
    StationDwellRule,
    TaskTimeoutRule,
    ZoneViolationRule,
)
from edge_platform.spatial import BoundingBox, Pose

BASE_TS = 1785300000000  # 固定时间起点（ms），保证测试可重复


def mk_ctx(
    fused_state=None, device_state=None, task_state=None, spatial_registry=None, zone_registry=None, now_ts=None
):
    """构造评估上下文。"""
    return {
        "fused_state": fused_state or {},
        "device_state": device_state,
        "task_state": task_state,
        "spatial_registry": spatial_registry,
        "zone_registry": zone_registry,
        "now_ts": now_ts if now_ts is not None else ms_to_ts(BASE_TS),
    }


# ---------- 1. PostureThresholdRule ----------


class PostureThresholdTest(unittest.TestCase):
    def test_sustained_high_pitch_triggers(self):
        # 持续 5s 阈值，连续 6 秒高前倾角 → 第 5 秒触发
        rule = PostureThresholdRule(config={"trunk_pitch_deg": 45.0, "sustained_sec": 5})
        findings = []
        for i in range(7):
            ctx = mk_ctx(
                fused_state={
                    "person_id": "P1",
                    "device_id": "D1",
                    "station_id": "STN-1",
                    "trunk_pitch_deg": 60.0,
                    "pose": Pose(x=1.0, y=1.0, confidence=0.92),
                },
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            f = rule.evaluate(ctx)
            if f is not None:
                findings.append(f)
        self.assertEqual(len(findings), 1, "持续高前倾角应触发一次")
        finding = findings[0]
        self.assertEqual(finding.rule_id, "POSTURE_THRESHOLD")
        self.assertEqual(finding.rule_version, "spatial-rule-v1.0")
        self.assertEqual(finding.severity, "L1")
        self.assertEqual(finding.person_id, "P1")
        self.assertEqual(finding.device_id, "D1")
        self.assertEqual(finding.station_id, "STN-1")
        self.assertGreater(finding.evidence["trunk_pitch_deg"], 45.0)
        self.assertEqual(finding.evidence["sustained_sec"], 5)
        self.assertIn("since_ts", finding.evidence)
        self.assertIn("ref", finding.evidence)  # 证据引用
        self.assertAlmostEqual(finding.confidence, 0.92)
        # 已触发未收口 → 后续帧不重复触发
        again = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "trunk_pitch_deg": 60.0, "pose": Pose()},
                now_ts=ms_to_ts(BASE_TS + 10 * 1000),
            )
        )
        self.assertIsNone(again)

    def test_brief_spike_does_not_trigger(self):
        # 持续 5s 阈值；仅 3 秒高前倾角后恢复 → 不触发
        rule = PostureThresholdRule(config={"sustained_sec": 5})
        for i in range(3):
            ctx = mk_ctx(
                fused_state={"person_id": "P1", "trunk_pitch_deg": 60.0, "pose": Pose()},
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            self.assertIsNone(rule.evaluate(ctx))
        # 恢复正常姿态 → 状态机复位
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "trunk_pitch_deg": 10.0, "pose": Pose()},
            now_ts=ms_to_ts(BASE_TS + 3 * 1000),
        )
        self.assertIsNone(rule.evaluate(ctx))
        # 复位后再持续 3 秒仍不够 5 秒 → 不触发
        for i in range(4, 7):
            ctx = mk_ctx(
                fused_state={"person_id": "P1", "trunk_pitch_deg": 60.0, "pose": Pose()},
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            self.assertIsNone(rule.evaluate(ctx))

    def test_missing_pitch_returns_none(self):
        rule = PostureThresholdRule(config={"sustained_sec": 1})
        ctx = mk_ctx(fused_state={"person_id": "P1"}, now_ts=ms_to_ts(BASE_TS))
        self.assertIsNone(rule.evaluate(ctx))


# ---------- 2. BatteryPredictionRule ----------


class BatteryPredictionTest(unittest.TestCase):
    def test_high_drain_low_battery_predicts_soon(self):
        # 当前 25%，放电 2%/min → 5 分钟后到 20%，在 15 分钟窗口内
        rule = BatteryPredictionRule(config={"low_threshold": 20.0, "horizon_min": 15})
        ctx = mk_ctx(
            fused_state={
                "person_id": "P1",
                "device_id": "D1",
                "station_id": "STN-1",
                "battery_percent": 25.0,
                "drain_rate_per_min": 2.0,
            },
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "BATTERY_PREDICTION")
        self.assertEqual(finding.person_id, "P1")
        self.assertEqual(finding.device_id, "D1")
        self.assertLess(finding.evidence["predicted_min_to_low"], 15)
        self.assertGreater(finding.evidence["predicted_min_to_low"], 0)
        self.assertAlmostEqual(finding.evidence["drain_rate_per_min"], 2.0)
        self.assertAlmostEqual(finding.evidence["battery_percent"], 25.0)

    def test_no_finding_when_battery_high(self):
        # 当前 90%，放电 0.5%/min → 140 分钟后到 20%，超出 15 分钟窗口
        rule = BatteryPredictionRule(config={"low_threshold": 20.0, "horizon_min": 15})
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1", "battery_percent": 90.0, "drain_rate_per_min": 0.5},
            now_ts=ms_to_ts(BASE_TS),
        )
        self.assertIsNone(rule.evaluate(ctx))

    def test_no_finding_when_already_low(self):
        # 已低于阈值 → 不预测（由其他规则处理低电量本身）
        rule = BatteryPredictionRule(config={"low_threshold": 20.0, "horizon_min": 15})
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1", "battery_percent": 15.0, "drain_rate_per_min": 2.0},
            now_ts=ms_to_ts(BASE_TS),
        )
        self.assertIsNone(rule.evaluate(ctx))

    def test_internal_drain_estimate_from_history(self):
        # 未提供 drain_rate_per_min → 内部按历史样本估算
        rule = BatteryPredictionRule(config={"low_threshold": 20.0, "horizon_min": 30})
        # 10 分钟内从 50% 降到 30%，drain = 2%/min → 5 分钟到 20%
        rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "device_id": "D1", "battery_percent": 50.0},
                now_ts=ms_to_ts(BASE_TS),
            )
        )
        finding = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "device_id": "D1", "battery_percent": 30.0},
                now_ts=ms_to_ts(BASE_TS + 10 * 60 * 1000),
            )
        )
        self.assertIsNotNone(finding)
        self.assertLess(finding.evidence["predicted_min_to_low"], 30)


# ---------- 3. ZoneViolationRule ----------


class ZoneViolationTest(unittest.TestCase):
    def _zones(self):
        return [
            {
                "zone_id": "Z-FORBID-1",
                "bbox": BoundingBox(min_x=0.0, min_y=0.0, max_x=5.0, max_y=5.0),
                "status": "forbidden",
            }
        ]

    def test_person_inside_forbidden_zone_fires(self):
        rule = ZoneViolationRule()
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1", "pose": Pose(x=2.0, y=2.0, confidence=0.95)},
            zone_registry=self._zones(),
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "ZONE_VIOLATION")
        self.assertEqual(finding.severity, "L1")
        self.assertEqual(finding.evidence["zone_id"], "Z-FORBID-1")
        self.assertEqual(finding.evidence["zone_label"], "forbidden")
        self.assertAlmostEqual(finding.confidence, 0.95)

    def test_person_outside_no_finding(self):
        rule = ZoneViolationRule()
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1", "pose": Pose(x=10.0, y=10.0)},
            zone_registry=self._zones(),
            now_ts=ms_to_ts(BASE_TS),
        )
        self.assertIsNone(rule.evaluate(ctx))

    def test_dict_pose_supported(self):
        # duck-typed：dict 形式 pose 也能识别
        rule = ZoneViolationRule()
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1", "pose": {"x": 1.0, "y": 1.0, "confidence": 0.8}},
            zone_registry=self._zones(),
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertAlmostEqual(finding.confidence, 0.8)

    def test_non_forbidden_zone_ignored(self):
        rule = ZoneViolationRule()
        zones = [{"zone_id": "Z-NORMAL", "bbox": BoundingBox(0, 0, 5, 5), "status": "active"}]
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "pose": Pose(x=2.0, y=2.0)},
            zone_registry=zones,
            now_ts=ms_to_ts(BASE_TS),
        )
        self.assertIsNone(rule.evaluate(ctx))

    def test_leave_then_reenter(self):
        rule = ZoneViolationRule()
        # 进入 → 触发
        f1 = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "pose": Pose(x=2.0, y=2.0)},
                zone_registry=self._zones(),
                now_ts=ms_to_ts(BASE_TS),
            )
        )
        self.assertIsNotNone(f1)
        # 仍在禁区 → 不重复触发
        f2 = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "pose": Pose(x=3.0, y=3.0)},
                zone_registry=self._zones(),
                now_ts=ms_to_ts(BASE_TS + 1000),
            )
        )
        self.assertIsNone(f2)
        # 离开 → 复位
        rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "pose": Pose(x=10.0, y=10.0)},
                zone_registry=self._zones(),
                now_ts=ms_to_ts(BASE_TS + 2000),
            )
        )
        # 再次进入 → 重新触发
        f3 = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "pose": Pose(x=1.0, y=1.0)},
                zone_registry=self._zones(),
                now_ts=ms_to_ts(BASE_TS + 3000),
            )
        )
        self.assertIsNotNone(f3)


# ---------- 4. CumulativeLoadIntegralRule ----------


class CumulativeLoadIntegralTest(unittest.TestCase):
    def test_accumulating_load_crosses_threshold(self):
        # 阈值 5.0；load_score=1.0，每秒评估一次；5 秒后累积 5.0 → 触发
        rule = CumulativeLoadIntegralRule(config={"threshold": 5.0})
        findings = []
        for i in range(7):
            ctx = mk_ctx(
                fused_state={
                    "person_id": "P1",
                    "device_id": "D1",
                    "station_id": "STN-1",
                    "load_score": 1.0,
                    "shift_start_ts": ms_to_ts(BASE_TS),
                },
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            f = rule.evaluate(ctx)
            if f is not None:
                findings.append(f)
        self.assertEqual(len(findings), 1, "累计负荷应跨阈值触发一次")
        finding = findings[0]
        self.assertEqual(finding.rule_id, "CUMULATIVE_LOAD_INTEGRAL")
        self.assertEqual(finding.severity, "L2")
        self.assertGreaterEqual(finding.evidence["cumulative_load"], 5.0)
        self.assertEqual(finding.evidence["threshold"], 5.0)
        self.assertAlmostEqual(finding.evidence["current_load_score"], 1.0)

    def test_below_threshold_no_finding(self):
        rule = CumulativeLoadIntegralRule(config={"threshold": 100.0})
        for i in range(5):
            ctx = mk_ctx(
                fused_state={"person_id": "P1", "load_score": 1.0, "shift_start_ts": ms_to_ts(BASE_TS)},
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            self.assertIsNone(rule.evaluate(ctx))

    def test_shift_change_resets_accumulator(self):
        rule = CumulativeLoadIntegralRule(config={"threshold": 3.0})
        # 第一班次累积 2 秒 → value=2.0
        for i in range(3):
            rule.evaluate(
                mk_ctx(
                    fused_state={"person_id": "P1", "load_score": 1.0, "shift_start_ts": ms_to_ts(BASE_TS)},
                    now_ts=ms_to_ts(BASE_TS + i * 1000),
                )
            )
        # 换班 → 累计器复位，重新从 0 开始
        findings = []
        for i in range(5):
            f = rule.evaluate(
                mk_ctx(
                    fused_state={"person_id": "P1", "load_score": 1.0, "shift_start_ts": ms_to_ts(BASE_TS + 100000)},
                    now_ts=ms_to_ts(BASE_TS + 100000 + i * 1000),
                )
            )
            if f is not None:
                findings.append(f)
        # 新班次 4 秒累积 4.0 ≥ 3.0 → 触发一次
        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertLess(finding.evidence["cumulative_load"], 10.0)  # 非跨班累加

    def test_reset_method(self):
        rule = CumulativeLoadIntegralRule(config={"threshold": 1.0})
        for i in range(3):
            rule.evaluate(
                mk_ctx(
                    fused_state={"person_id": "P1", "load_score": 1.0, "shift_start_ts": ms_to_ts(BASE_TS)},
                    now_ts=ms_to_ts(BASE_TS + i * 1000),
                )
            )
        # 手动复位
        rule.reset("P1")
        # 重新累积，首帧 dt=0 不累积
        f = rule.evaluate(
            mk_ctx(
                fused_state={"person_id": "P1", "load_score": 1.0, "shift_start_ts": ms_to_ts(BASE_TS)},
                now_ts=ms_to_ts(BASE_TS + 10000),
            )
        )
        self.assertIsNone(f)


# ---------- 5. RuleRegistry ----------


class RuleRegistryTest(unittest.TestCase):
    def test_register_two_rules_and_evaluate_all(self):
        reg = RuleRegistry()
        r1 = PostureThresholdRule(config={"trunk_pitch_deg": 45.0, "sustained_sec": 1})
        r2 = ZoneViolationRule()
        reg.register(r1)
        reg.register(r2)
        self.assertEqual(len(reg.all()), 2)

        # 同一上下文同时满足两条规则：姿态持续 1s 触发 + 禁区闯入触发
        zone_bbox = BoundingBox(min_x=0.0, min_y=0.0, max_x=5.0, max_y=5.0)
        zones = [{"zone_id": "Z1", "bbox": zone_bbox, "status": "forbidden"}]
        all_findings = []
        for i in range(3):
            ctx = mk_ctx(
                fused_state={
                    "person_id": "P1",
                    "device_id": "D1",
                    "station_id": "STN-1",
                    "trunk_pitch_deg": 60.0,
                    "pose": Pose(x=2.0, y=2.0, confidence=0.9),
                },
                zone_registry=zones,
                now_ts=ms_to_ts(BASE_TS + i * 1000),
            )
            all_findings.extend(reg.evaluate_all(ctx))
        rule_ids = {f.rule_id for f in all_findings}
        self.assertIn("POSTURE_THRESHOLD", rule_ids)
        self.assertIn("ZONE_VIOLATION", rule_ids)
        # 每条 finding 都携带规则版本与严重级
        for f in all_findings:
            self.assertEqual(f.rule_version, "spatial-rule-v1.0")
            self.assertIn(f.severity, ("L1", "L2"))

    def test_version_history_retained(self):
        reg = RuleRegistry()
        v1 = PostureThresholdRule(config={"sustained_sec": 5}, rule_version="spatial-rule-v1.0")
        v2 = PostureThresholdRule(config={"sustained_sec": 3}, rule_version="spatial-rule-v1.1")
        reg.register(v1)
        reg.register(v2)
        # 版本历史保留（不覆盖）
        self.assertEqual(reg.versions("POSTURE_THRESHOLD"), ["spatial-rule-v1.0", "spatial-rule-v1.1"])
        self.assertEqual(len(reg.by_id("POSTURE_THRESHOLD")), 2)
        # all() 返回最新版本
        self.assertEqual(reg.all()[0].rule_version, "spatial-rule-v1.1")
        # 默认两个版本都启用
        self.assertEqual(len(reg.enabled()), 2)

    def test_enable_disable_versioned(self):
        reg = RuleRegistry()
        v1 = PostureThresholdRule(config={"sustained_sec": 5}, rule_version="spatial-rule-v1.0")
        v2 = PostureThresholdRule(config={"sustained_sec": 3}, rule_version="spatial-rule-v1.1")
        reg.register(v1)
        reg.register(v2)
        # 禁用旧版本
        self.assertTrue(reg.disable("POSTURE_THRESHOLD", "spatial-rule-v1.0"))
        self.assertFalse(reg.is_enabled("POSTURE_THRESHOLD", "spatial-rule-v1.0"))
        self.assertTrue(reg.is_enabled("POSTURE_THRESHOLD", "spatial-rule-v1.1"))
        enabled = reg.enabled()
        self.assertEqual(len(enabled), 1)
        self.assertEqual(enabled[0].rule_version, "spatial-rule-v1.1")
        # 重新启用
        self.assertTrue(reg.enable("POSTURE_THRESHOLD", "spatial-rule-v1.0"))
        self.assertEqual(len(reg.enabled()), 2)
        # 禁用全部版本
        self.assertTrue(reg.disable("POSTURE_THRESHOLD"))
        self.assertEqual(len(reg.enabled()), 0)

    def test_evaluate_all_respects_disabled(self):
        reg = RuleRegistry()
        r = ZoneViolationRule()
        reg.register(r)
        reg.disable("ZONE_VIOLATION")
        zones = [{"zone_id": "Z1", "bbox": BoundingBox(0, 0, 5, 5), "status": "forbidden"}]
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "pose": Pose(x=2.0, y=2.0)},
            zone_registry=zones,
            now_ts=ms_to_ts(BASE_TS),
        )
        self.assertEqual(reg.evaluate_all(ctx), [])

    def test_register_rejects_non_rule(self):
        reg = RuleRegistry()
        with self.assertRaises(TypeError):
            reg.register(object())


# ---------- 其他规则冒烟测试（保证 10 条规则均可实例化与评估） ----------


class AllRulesSmokeTest(unittest.TestCase):
    """对未在上述用例覆盖的规则做最小冒烟，确保接口完整。"""

    def test_high_load_duration(self):
        rule = HighLoadDurationRule(config={"sustained_sec": 1})
        findings = []
        for i in range(3):
            f = rule.evaluate(
                mk_ctx(
                    fused_state={"person_id": "P1", "device_id": "D1", "assist_level": 0.9, "torque_nm": 30.0},
                    now_ts=ms_to_ts(BASE_TS + i * 1000),
                )
            )
            if f is not None:
                findings.append(f)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule_id, "HIGH_LOAD_DURATION")

    def test_action_count_via_current_action(self):
        rule = ActionCountRule(config={"window_sec": 60, "max_count": 2})
        findings = []
        for i in range(4):
            f = rule.evaluate(
                mk_ctx(
                    fused_state={"person_id": "P1", "device_id": "D1", "current_action": "lift"},
                    now_ts=ms_to_ts(BASE_TS + i * 1000),
                )
            )
            if f is not None:
                findings.append(f)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule_id, "ACTION_COUNT")
        self.assertGreater(findings[0].evidence["count"], 2)

    def test_offline_detection(self):
        rule = OfflineDetectionRule(config={"offline_sec": 30})
        ctx = mk_ctx(
            fused_state={"person_id": "P1", "device_id": "D1"},
            device_state={"device_id": "D1", "last_seen_ts": ms_to_ts(BASE_TS - 60000)},
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "DEVICE_OFFLINE_PREDICTION")
        self.assertGreaterEqual(finding.evidence["gap_sec"], 30)

    def test_station_dwell(self):
        rule = StationDwellRule(config={"dwell_slack_sec": 0, "default_expected_dwell_sec": 60})
        ctx = mk_ctx(
            fused_state={
                "person_id": "P1",
                "device_id": "D1",
                "station_id": "STN-1",
                "station_enter_ts": ms_to_ts(BASE_TS - 120000),
                "expected_dwell_sec": 60,
            },
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "STATION_DWELL")

    def test_task_timeout_start_overdue(self):
        rule = TaskTimeoutRule(config={"start_overdue_sec": 30})
        ctx = mk_ctx(
            fused_state={"device_id": "D1", "station_id": "STN-1"},
            task_state={
                "task_id": "TASK-1",
                "person_id": "P1",
                "start_deadline_ts": ms_to_ts(BASE_TS - 60000),
                "complete_deadline_ts": ms_to_ts(BASE_TS + 60000),
                "started_ts": None,
                "completed_ts": None,
            },
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "TASK_TIMEOUT")
        self.assertEqual(finding.evidence["kind"], "start_overdue")

    def test_task_timeout_complete_overdue(self):
        rule = TaskTimeoutRule()
        ctx = mk_ctx(
            fused_state={"device_id": "D1"},
            task_state={
                "task_id": "TASK-2",
                "person_id": "P1",
                "start_deadline_ts": ms_to_ts(BASE_TS - 120000),
                "complete_deadline_ts": ms_to_ts(BASE_TS - 30000),
                "started_ts": ms_to_ts(BASE_TS - 110000),
                "completed_ts": None,
            },
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.evidence["kind"], "complete_overdue")

    def test_sensor_conflict(self):
        rule = SensorConflictRule()
        ctx = mk_ctx(
            fused_state={
                "person_id": "P1",
                "device_id": "D1",
                "sensor_conflicts": [
                    {
                        "type": "uwb_vs_vision",
                        "uwb_station": "STN-A",
                        "vision_station": "STN-B",
                        "uwb_confidence": 0.9,
                        "vision_confidence": 0.8,
                        "ts_ms": BASE_TS,
                    }
                ],
            },
            now_ts=ms_to_ts(BASE_TS),
        )
        finding = rule.evaluate(ctx)
        self.assertIsNotNone(finding)
        self.assertEqual(finding.rule_id, "SENSOR_CONFLICT")
        self.assertEqual(finding.evidence["uwb_station"], "STN-A")
        self.assertEqual(finding.evidence["vision_station"], "STN-B")
        self.assertAlmostEqual(finding.confidence, 0.8)

    def test_rulefinding_to_dict(self):
        f = RuleFinding(
            rule_id="X",
            rule_version="v1",
            severity="L1",
            person_id="P1",
            device_id="D1",
            station_id="S1",
            message="m",
            evidence={"a": 1},
            triggered_at="2026-01-01T00:00:00+00:00",
            confidence=0.5,
        )
        d = f.to_dict()
        self.assertEqual(d["rule_id"], "X")
        self.assertEqual(d["evidence"], {"a": 1})
        self.assertAlmostEqual(d["confidence"], 0.5)


if __name__ == "__main__":
    unittest.main()
