"""故障门控执行机构传输单测（NO-68h 收口：tools 冒烟 → 正式单测）。

安全语义（不可变）：
- 正常态 dispatch_task 接受；
- fault 态拒绝 dispatch_task / resume / return_to_dock（reason=device_faulted），
  拒绝进入 command_log（accepted=false + reason，账目可回答"为什么没动"）；
- stop 永远允许（安全停机不受故障门控限制）；
- clear_fault / pause 不在门控内（故障处置本身必须可用）。
"""

import unittest

from edge_platform.edge.adapters.actuator.fault_gated import FaultGatedActuatorTransport
from edge_platform.edge.adapters.actuator.protocol import ActuatorCommand


def _cmd(key: str, ref: str = "control:t1") -> ActuatorCommand:
    return ActuatorCommand(
        device_id="TWIN-GUARD",
        command_key=key,
        payload={"targetStationId": "ST-X"} if key == "dispatch_task" else {},
        authorization_ref=ref,
    )


class FaultGatedActuatorTransportTest(unittest.TestCase):
    def setUp(self):
        self.dev = FaultGatedActuatorTransport("TWIN-GUARD", now_fn=lambda: "now")
        self.dev.register_station("ST-X", 1.0, 1.0)

    def _fault(self):
        self.dev.inject_fault("PLC_ESTOP_SIM")

    def test_normal_state_accepts_dispatch(self):
        self.assertTrue(self.dev.send(_cmd("dispatch_task")).accepted)

    def test_fault_state_rejects_moving_commands_with_reason(self):
        self._fault()
        for key in ("dispatch_task", "resume", "return_to_dock"):
            result = self.dev.send(_cmd(key))
            self.assertFalse(result.accepted, f"fault 态 {key} 应被拒")
            self.assertEqual(result.reason, "device_faulted")

    def test_stop_always_allowed_even_in_fault(self):
        self._fault()
        self.assertTrue(self.dev.send(_cmd("stop")).accepted)

    def test_clear_fault_allowed_in_fault_state(self):
        self._fault()
        self.assertTrue(self.dev.send(_cmd("clear_fault")).accepted)
        self.assertEqual(self.dev.state.state, "idle")

    def test_rejection_logged_with_reason(self):
        self._fault()
        self.dev.send(_cmd("dispatch_task", ref="control:t9"))
        rejects = [e for e in self.dev.command_log if e.get("accepted") is False]
        self.assertEqual(len(rejects), 1)
        self.assertEqual(rejects[0]["reason"], "device_faulted")
        self.assertEqual(rejects[0]["authorization_ref"], "control:t9")

    def test_recovery_restores_dispatch(self):
        self._fault()
        self.assertFalse(self.dev.send(_cmd("dispatch_task")).accepted)
        self.dev.send(_cmd("clear_fault"))
        self.assertTrue(self.dev.send(_cmd("dispatch_task")).accepted)


if __name__ == "__main__":
    unittest.main()
