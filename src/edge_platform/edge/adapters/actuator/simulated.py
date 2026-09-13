"""执行机构模拟设备（NO-59b）：无硬件时提供可替换的"数字孪生车辆"。

与 `LoopbackActuatorTransport` 的分工：
- Transport 只做"命令 → 状态迁移"的协议语义（回环、确定性）；
- 本类把 Transport 包装成**会自己跑的模拟设备**：按 `hz` 周期产出状态帧、
  在给定工位之间自动派工（派工带**模拟授权号** `plan:<id>`——即便在模拟里，
  "设备为什么在动"也必须可追溯），供边缘模拟器/演示与 e2e 使用。

真实设备的替换点：现场用真实 `ActuatorTransport`（Modbus/OPC-UA/厂商 API）替换即可，
上层（adapter 判定顺序、帧契约、上行端点）完全不变。
"""

from __future__ import annotations

import time

from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter
from edge_platform.edge.adapters.actuator.protocol import ActuatorCommand, LoopbackActuatorTransport
from edge_platform.spatial import now_iso


class SimulatedActuatorAdapter(ActuatorAdapter):
    """按固定路线自动搬运的模拟 AGV（确定性：固定路线 + 无随机数）。"""

    def __init__(
        self,
        device_id,
        stations: list[tuple[str, float, float]] | None = None,
        hz: float = 1.0,
        source_type: str = "simulated",
        battery_pct: float = 96.0,
        authorization_id: str | None = None,
    ):
        transport = LoopbackActuatorTransport(
            device_id, now_fn=now_iso, x=0.0, y=0.0, battery_pct=battery_pct, step_m=1.0
        )
        super().__init__(
            device_id,
            source_type=source_type,
            model="AGV-SIM",
            firmware_version="sim-1.0",
            transport=transport,
            tick_on_read=True,
        )
        self.hz = max(float(hz), 0.1)
        self._route = stations or [("ST-SIM-1", 3.0, 0.0), ("ST-SIM-2", 3.0, 4.0), ("DOCK", 0.0, 0.0)]
        for station_id, x, y in self._route:
            transport.register_station(station_id, x, y)
        self._route_index = 0
        self._next_emit_at = 0.0
        self._authorization_id = authorization_id or f"plan:SIM-{device_id}"
        self._last_known_state = "idle"

    def _ensure_moving(self) -> None:
        """空闲/到达后自动派下一站（带模拟授权号——「在动」必有来源）。"""
        state = self.transport.recv(timeout=0)
        if state is None:
            return
        if state.state in ("idle", "arrived"):
            target = self._route[self._route_index % len(self._route)]
            self._route_index += 1
            self.transport.send(
                ActuatorCommand(
                    device_id=self.device_id,
                    command_key="dispatch_task",
                    authorization_ref=self._authorization_id,
                    payload={"targetStationId": target[0], "taskId": f"SIM-TASK-{self._route_index}"},
                    requested_at=now_iso(),
                )
            )

    def read_message(self, timeout=None):
        """按 hz 周期推进并返回统一状态帧（模拟器读取循环直接消费）。"""
        now = time.monotonic()
        if self._next_emit_at == 0.0:
            self._next_emit_at = now
        wait = self._next_emit_at - now
        if wait > 0:
            time.sleep(min(wait, timeout if timeout else wait))
        self._next_emit_at = max(self._next_emit_at, time.monotonic()) + (1.0 / self.hz)
        self._ensure_moving()
        frame = self.poll_state()
        self._last_known_state = frame.get("state", "unknown")
        return frame


__all__ = ["SimulatedActuatorAdapter"]
