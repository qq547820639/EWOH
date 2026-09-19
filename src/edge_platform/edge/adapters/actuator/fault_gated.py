"""故障门控执行机构传输（数字孪生用，纵深防御语义）。

背景（2026-09-15 仿真对抗）：`LoopbackActuatorTransport` 对**共享回环孪生**不检查
故障态（对它而言故障只是状态机一态）；但现场真实车辆/PLC 在急停/故障时不会接受
新任务。数字孪生按「真实设备不带病执行」的**前提**建模（该前提属设备控制器层，
真机边界）——故障态拒绝需要移动/恢复类命令，返回 `device_faulted`。

安全语义（不可变）：
- `stop` 永远允许（安全停机不受故障门控限制，与平台侧 stop 免审批同纪律）；
- `clear_fault` / `pause` 不在门控内（故障处置本身必须可用）；
- 拒绝同样进入 command_log（accepted=false + reason），账目可回答"这条命令为什么没动"。
"""

from __future__ import annotations

from .protocol import ActuatorCommand, LoopbackActuatorTransport, TransportResult


class FaultGatedActuatorTransport(LoopbackActuatorTransport):
    """fault 态拒绝 dispatch_task / resume / return_to_dock（真实设备不带病执行）。"""

    _FAULT_BLOCKED_COMMANDS = ("dispatch_task", "resume", "return_to_dock")

    def send(self, command: ActuatorCommand) -> TransportResult:
        if self.state.state == "fault" and command.command_key in self._FAULT_BLOCKED_COMMANDS:
            # 拒绝也进命令账目（带原因）——现场可回答"这条命令为什么没动"。
            self.command_log.append(
                {
                    "command_key": command.command_key,
                    "authorization_ref": command.authorization_ref,
                    "at": self._now(),
                    "state": self.state.state,
                    "accepted": False,
                    "reason": "device_faulted",
                }
            )
            return TransportResult(accepted=False, reason="device_faulted", state=self.state)
        return super().send(command)


__all__ = ["FaultGatedActuatorTransport"]
