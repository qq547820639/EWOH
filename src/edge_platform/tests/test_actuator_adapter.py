"""执行机构（AGV/PLC）适配器与命令面测试（NO-59b）。

钉住的语义：
  1. 回环模拟器确定性推进：dispatch → moving → arrived（含任务号/目标工位）；
  2. 高危命令**必须有平台授权号**，缺失与形状非法是两种不同拒绝原因；
  3. `stop` 是安全动作：不要授权号、故障态也允许（安全停机不被审批链卡住）；
  4. 故障态拒绝新任务（device_fault:CODE），`clear_fault` 可清障；
  5. 未启动 → transport_offline；未知命令 → unknown_command_key（封闭词表）；
  6. 低电量自动转故障（模拟器不美化）；
  7. 统一状态帧含设备级/运动级/业务级三段，且**不泄漏厂商字段**；
  8. 工厂 kind=agv 可构造，未知参数 fail-closed。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapter_factory import build_adapters
from edge_platform.edge.adapters.actuator import (
    ACTUATOR_COMMAND_PRIORITY,
    ACTUATOR_COMMANDS,
    ACTUATOR_HIGH_RISK_COMMANDS,
    UNKNOWN_COMMAND_PRIORITY,
    ActuatorAdapter,
    LoopbackActuatorTransport,
    authorization_fingerprint,
    authorization_ref_valid,
    command_priority,
    fnv1a64_hex,
)


def make_adapter(**kwargs):
    adapter = ActuatorAdapter("AGV-01", source_type="simulated", **kwargs)
    adapter.start()
    transport = adapter.transport
    transport.register_station("ST-1", 3.0, 4.0)
    transport.register_station("ST-2", 0.0, 10.0)
    return adapter, transport


class ActuatorCommandAuthTest(unittest.TestCase):
    def test_high_risk_requires_authorization(self):
        adapter, _ = make_adapter()
        result = adapter.send_command("dispatch_task", payload={"targetStationId": "ST-1"})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "authorization_required")
        self.assertEqual(result["device_id"], "AGV-01")
        # 拒绝也要留痕：命令面不许"悄悄没发出去"
        self.assertEqual(adapter.command_log[-1]["accepted"], False)
        self.assertEqual(adapter.command_log[-1]["reason"], "authorization_required")

    def test_invalid_authorization_ref_is_a_different_reason(self):
        adapter, _ = make_adapter()
        result = adapter.send_command("dispatch_task", "nope:1", {"targetStationId": "ST-1"})
        self.assertEqual(result["reason"], "authorization_ref_invalid")
        # 规范前缀白名单
        for good in ("control:CR-1", "approval:AP-1", "plan:PLAN-1", "task:TASK-1"):
            self.assertTrue(authorization_ref_valid(good), good)
        for bad in ("", "  ", "CR-1", "ControlX:1", "control:", "approval:  "):
            self.assertFalse(authorization_ref_valid(bad), bad)

    def test_stop_is_safety_command_without_authorization(self):
        adapter, _ = make_adapter()
        adapter.transport.inject_fault("E-STOP")
        result = adapter.send_command("stop")
        self.assertTrue(result["accepted"])
        self.assertTrue(result["safety_command"])
        self.assertEqual(result["state"]["state"], "idle")

    def test_unknown_command_key_is_rejected(self):
        adapter, _ = make_adapter()
        result = adapter.send_command("launch_missile", "control:CR-1")
        self.assertEqual(result["reason"], "unknown_command_key")
        self.assertIn("launch_missile", result["command_key"])
        self.assertNotIn("launch_missile", ACTUATOR_COMMANDS)

    def test_transport_offline_when_not_started(self):
        adapter = ActuatorAdapter("AGV-02", source_type="simulated")
        result = adapter.send_command("dispatch_task", "control:CR-2", {"targetStationId": "ST-1"})
        self.assertEqual(result["reason"], "transport_offline")

    def test_high_risk_command_list_is_closed_and_explicit(self):
        self.assertEqual(
            tuple(ACTUATOR_HIGH_RISK_COMMANDS),
            ("dispatch_task", "resume", "clear_fault"),
        )


class ActuatorLoopbackTest(unittest.TestCase):
    def test_dispatch_moves_then_arrives(self):
        adapter, _ = make_adapter()
        result = adapter.send_command(
            "dispatch_task", "control:CR-9", {"targetStationId": "ST-1", "taskId": "T-9"}
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["state"]["state"], "moving")
        self.assertEqual(result["state"]["business"]["target_station_id"], "ST-1")

        for _ in range(6):  # 距离 5m、步长 1m → 5 步到达
            frame = adapter.poll_state()
        self.assertEqual(frame["state"], "arrived")
        self.assertEqual(frame["motion"]["x"], 3.0)
        self.assertEqual(frame["motion"]["y"], 4.0)
        self.assertEqual(frame["business"]["current_task_id"], "T-9")
        self.assertEqual(frame["business"]["last_authorization_ref"], "control:CR-9")

    def test_dispatch_without_target_station_is_rejected(self):
        adapter, _ = make_adapter()
        result = adapter.send_command("dispatch_task", "control:CR-9", {})
        self.assertEqual(result["reason"], "target_station_required")

    def test_unknown_target_station_becomes_explicit_fault(self):
        adapter, _ = make_adapter()
        adapter.send_command("dispatch_task", "control:CR-9", {"targetStationId": "ST-404"})
        frame = adapter.poll_state()
        self.assertEqual(frame["state"], "fault")
        self.assertEqual(frame["device"]["fault_code"], "TARGET_STATION_UNKNOWN")

    def test_pause_resume_only_in_right_state(self):
        adapter, _ = make_adapter()
        self.assertEqual(adapter.send_command("pause")["reason"], "not_moving")
        adapter.send_command("dispatch_task", "control:CR-1", {"targetStationId": "ST-2"})
        self.assertTrue(adapter.send_command("pause")["accepted"])
        self.assertEqual(adapter.send_command("pause")["reason"], "not_moving")
        # resume 是高危（重新动起来）：必须带授权号
        self.assertEqual(adapter.send_command("resume")["reason"], "authorization_required")
        self.assertTrue(adapter.send_command("resume", "control:CR-1")["accepted"])
        self.assertEqual(adapter.send_command("resume", "control:CR-1")["reason"], "not_paused")

    def test_fault_blocks_new_tasks_but_allows_clear(self):
        adapter, _ = make_adapter()
        adapter.transport.inject_fault("MOTOR_OVERHEAT")
        blocked = adapter.send_command("dispatch_task", "control:CR-1", {"targetStationId": "ST-1"})
        self.assertEqual(blocked["reason"], "device_fault:MOTOR_OVERHEAT")
        self.assertEqual(adapter.send_command("clear_fault")["reason"], "authorization_required")
        cleared = adapter.send_command("clear_fault", "control:CR-1")
        self.assertTrue(cleared["accepted"])
        self.assertEqual(cleared["state"]["device"]["fault_code"], None)

    def test_low_battery_forces_fault(self):
        adapter, _ = make_adapter(battery_pct=5.2, low_battery_pct=5.0)
        adapter.transport.battery_drain_pct_per_tick = 0.5
        frame = adapter.poll_state()
        self.assertEqual(frame["state"], "fault")
        self.assertEqual(frame["device"]["fault_code"], "LOW_BATTERY")

    def test_return_to_dock_returns_idle(self):
        adapter, _ = make_adapter()
        adapter.send_command("dispatch_task", "control:CR-1", {"targetStationId": "ST-1"})
        for _ in range(6):
            adapter.poll_state()
        adapter.send_command("return_to_dock")
        for _ in range(6):
            frame = adapter.poll_state()
        self.assertEqual(frame["state"], "arrived")
        self.assertIsNone(frame["business"]["current_task_id"])

    def test_frame_has_no_vendor_fields_and_four_sections(self):
        adapter, _ = make_adapter()
        frame = adapter.poll_state()
        self.assertEqual(frame["type"], "agv")
        self.assertEqual(frame["mode"], "actuator")
        self.assertEqual(frame["source_type"], "simulated")
        for section in ("device", "motion", "business"):
            self.assertIn(section, frame)
        # 来源隔离 + 统一帧：厂商字段名不进统一帧
        self.assertNotIn("vendor_state", frame)
        self.assertEqual(adapter.device_info()["authorization_required_commands"],
                         list(ACTUATOR_HIGH_RISK_COMMANDS))

    def test_health_reports_degraded_on_fault(self):
        adapter, _ = make_adapter()
        self.assertEqual(adapter.health()["status"], "online")
        adapter.transport.inject_fault("X")
        health = adapter.health()
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(health["fault_code"], "X")
        adapter.stop()
        self.assertEqual(adapter.health()["status"], "offline")


class ActuatorFactoryTest(unittest.TestCase):
    def test_build_agv_kind(self):
        adapters = build_adapters(
            [{"kind": "agv", "deviceId": "AGV-77", "sourceType": "simulated",
              "stationId": "ST-9", "model": "AGV-X1", "lowBatteryPct": 7.5}]
        )
        self.assertEqual(len(adapters), 1)
        adapter = adapters[0]
        self.assertIsInstance(adapter, ActuatorAdapter)
        self.assertEqual(adapter.device_id, "AGV-77")
        self.assertEqual(adapter.station_id, "ST-9")
        self.assertEqual(adapter.model, "AGV-X1")
        self.assertIsInstance(adapter.transport, LoopbackActuatorTransport)

    def test_unknown_param_fails_closed(self):
        with self.assertRaises(ValueError):
            build_adapters([{"kind": "agv", "deviceId": "AGV-77", "bogusParam": 1}])


if __name__ == "__main__":
    unittest.main()


class ActuatorPriorityAndFingerprintTest(unittest.TestCase):
    """NO-62a/b：下行优先级与授权范围指纹（与平台侧逐位一致的跨语言契约）。

    为什么在边缘侧再钉一次固定向量：跨语言一致性由 TS 的 `shared/actuator.spec.ts`
    读本文件比对，但**本侧也必须能独立自证**——否则"改 Python 改坏了"要等到跑
    node 测试才发现，而现场用的是 Python 边缘。
    """

    def test_priority_vocabulary_is_closed_and_safety_first(self):
        for key in ACTUATOR_COMMANDS:
            self.assertIn(key, ACTUATOR_COMMAND_PRIORITY)
        self.assertEqual(command_priority("stop"), 0)
        self.assertLess(command_priority("stop"), command_priority("dispatch_task"))
        self.assertLess(command_priority("pause"), command_priority("resume"))
        # 未登记命令不得插队（大数 = 最后）
        self.assertEqual(command_priority("teleport"), UNKNOWN_COMMAND_PRIORITY)
        self.assertEqual(command_priority(None), UNKNOWN_COMMAND_PRIORITY)

    def test_fingerprint_fixed_vectors_match_platform(self):
        self.assertEqual(fnv1a64_hex(""), "cbf29ce484222325")
        self.assertEqual(
            authorization_fingerprint(
                "CR-1", "AGV-01", "dispatch_task", "AP-9",
                {"targetStationId": "ST-2", "taskId": "T-1"},
            ),
            "3fee66ed288edc16",
        )
        self.assertEqual(
            authorization_fingerprint("CR-1", "AGV-01", "stop"), "25ed1d2d56bd2bd8"
        )

    def test_fingerprint_changes_on_any_scope_change(self):
        base = authorization_fingerprint(
            "CR-1", "AGV-01", "dispatch_task", "AP-9", {"targetStationId": "ST-2"}
        )
        for changed in (
            authorization_fingerprint("CR-2", "AGV-01", "dispatch_task", "AP-9", {"targetStationId": "ST-2"}),
            authorization_fingerprint("CR-1", "AGV-02", "dispatch_task", "AP-9", {"targetStationId": "ST-2"}),
            authorization_fingerprint("CR-1", "AGV-01", "resume", "AP-9", {"targetStationId": "ST-2"}),
            authorization_fingerprint("CR-1", "AGV-01", "dispatch_task", "AP-10", {"targetStationId": "ST-2"}),
            authorization_fingerprint("CR-1", "AGV-01", "dispatch_task", "AP-9", {"targetStationId": "ST-3"}),
        ):
            self.assertNotEqual(changed, base)
        # 键序不同不算变化（规范化 JSON）
        self.assertEqual(
            authorization_fingerprint(
                "CR-1", "AGV-01", "dispatch_task", "AP-9",
                {"taskId": "T-1", "targetStationId": "ST-2"},
            ),
            authorization_fingerprint(
                "CR-1", "AGV-01", "dispatch_task", "AP-9",
                {"targetStationId": "ST-2", "taskId": "T-1"},
            ),
        )
