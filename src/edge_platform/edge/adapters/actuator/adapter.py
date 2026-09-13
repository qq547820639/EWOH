"""执行机构适配器（AGV/PLC）：命令面 fail-closed + 统一状态上行（NO-59b）。

职责边界（与愿景「执行边界」一致）：
- **上行**：`read_message()` 返回统一语义状态帧（`ActuatorState`），
  与遥测/事件同一条摄入链（来源隔离：`source_type` 继承 BaseAdapter 约束）；
- **下行**：`send_command()` 只接受**封闭词表**里的命令；高危命令（让设备动起来 /
  解除安全停机）必须带平台授权号（`control:`/`approval:`/`plan:`/`task:` 规范引用），
  否则显式拒绝并把拒绝原因写进结果与审计——**绝不静默丢弃，也绝不替平台"顺手执行"**；
- **例外**：`stop` 是安全动作，**永远不要求授权号**（安全停机不能被审批链卡住），
  且在故障态下也允许；这是本适配器唯一"绕过授权"的路径，且只朝向更安全的方向。

真实接入（现场）只需替换 Transport（Modbus/OPC-UA/厂商 API），本类的判定顺序、
审计与结果契约不变；`simulated`/`controlled_test` 来源与真机物理隔离由 BaseAdapter 保证。
"""

from __future__ import annotations

import queue
import threading

from edge_platform.edge.adapters.actuator.protocol import (
    ACTUATOR_COMMANDS,
    ACTUATOR_HIGH_RISK_COMMANDS,
    ACTUATOR_SAFETY_COMMANDS,
    ActuatorCommand,
    ActuatorState,
    ActuatorTransport,
    LoopbackActuatorTransport,
    TransportResult,
    authorization_ref_valid,
)
from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso


class ActuatorAdapter(BaseAdapter):
    """AGV/PLC 等执行机构的统一适配器。

    参数：
    - `device_id`：设备号（与平台设备台账同号）；
    - `transport`：协议实现（缺省用确定性回环模拟器；真实模式传入 Modbus/OPC-UA 实现）；
    - `station_id`：初始工位（可选，仅用于状态标注）；
    - `source_type`：real/controlled_test/simulated（BaseAdapter 约束）。
    """

    DEVICE_TYPE = "agv"

    def __init__(
        self,
        device_id,
        source_type="real",
        model="AGV-GENERIC",
        firmware_version="1.0",
        station_id=None,
        transport: ActuatorTransport | None = None,
        tick_on_read: bool = True,
        low_battery_pct: float = 5.0,
        battery_pct: float = 100.0,
    ):
        super().__init__(device_id, source_type=source_type, model=model, firmware_version=firmware_version)
        self.station_id = station_id
        # `battery_pct`/`low_battery_pct` 只用于**缺省回环模拟器**的初始状态（演示与单测需要
        # 从特定电量起跑）；传入真实 transport 时忽略（真机电量由设备自己上报，平台不预设）。
        self.transport = transport or LoopbackActuatorTransport(
            device_id, now_fn=now_iso, low_battery_pct=low_battery_pct, battery_pct=battery_pct
        )
        # 回环模拟器需要 tick 推进才有位移；真实 Transport 的 recv 返回实时状态，不 tick。
        self._tick_on_read = bool(tick_on_read) and isinstance(self.transport, LoopbackActuatorTransport)
        self._inbox: queue.Queue[dict] = queue.Queue(maxsize=256)
        self._last_state: ActuatorState | None = None
        self._last_seen = None
        self._lock = threading.Lock()
        #: 命令留痕（内存；权威留痕在 edge storage.audit_log，见 routes/actuators.py）
        self.command_log: list[dict] = []

    # ---- 生命周期 ----
    def start(self):
        self._running = True
        self._started_at = now_iso()

    def stop(self):
        self._running = False
        try:
            self.transport.close()
        except Exception:  # pragma: no cover - 关闭失败不影响停止语义
            pass

    def reconnect(self):
        """回环/真实 Transport 重建：本实现仅重置运行标志（真实实现应重连 socket）。"""
        if not self._running:
            self.start()
        return True

    # ---- 状态与元信息 ----
    def health(self):
        state = self._state()
        status = "offline" if not self._running else ("degraded" if state.state == "fault" else "online")
        out = {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": status,
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
            "state": state.state,
            "battery_pct": state.battery_pct,
            "fault_code": state.fault_code,
            "transport": self.transport.name,
        }
        out.update(self.health_extras())
        return out

    def device_info(self):
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "mode": "actuator",
            "model": self.model,
            "firmware_version": self.firmware_version,
            "protocol_version": self.firmware_version,
            "source_type": self.source_type,
            "station_id": self.station_id,
            "transport": self.transport.name,
            "command_keys": list(ACTUATOR_COMMANDS),
            "authorization_required_commands": list(ACTUATOR_HIGH_RISK_COMMANDS),
            "safety_commands": list(ACTUATOR_SAFETY_COMMANDS),
        }

    # ---- 上行 ----
    def read_message(self, timeout=None):
        """返回统一语义状态帧；无新状态时按 timeout 阻塞（超时返回 None）。"""
        try:
            return self._inbox.get(timeout=timeout) if timeout else self._inbox.get_nowait()
        except queue.Empty:
            return None

    def poll_state(self) -> dict:
        """主动读一次设备状态（供 API 查询；真实 Transport 的 recv 返回实时状态）。"""
        state = self._state()
        return self._frame(state)

    # ---- 下行 ----
    def send_command(
        self,
        command_key: str,
        authorization_ref: str | None = None,
        payload: dict | None = None,
    ) -> dict:
        """下发一条命令；返回结构化结果（accepted/reason/state）。

        **判定顺序（不可调换）**：
        1. 未启动 → `transport_offline`（真实设备没连上就不下发）；
        2. 未知命令 → `unknown_command_key`（封闭词表）；
        3. 高危命令缺授权号 → `authorization_required`；授权号形状非法 →
           `authorization_ref_invalid`（两码事，页面要能区分"没给"与"给错"）；
        4. 故障态且非安全/清障命令 → `device_fault`（不许在故障态继续接任务）；
        5. 其余交给 Transport；Transport 拒绝按原因原样回传（不美化）。
        """
        key = str(command_key or "").strip()
        ref = str(authorization_ref).strip() if authorization_ref else None
        at = now_iso()
        if not self._running:
            return self._result(False, "transport_offline", key, ref, at)
        if key not in ACTUATOR_COMMANDS:
            return self._result(False, "unknown_command_key", key, ref, at)
        is_safety = key in ACTUATOR_SAFETY_COMMANDS
        if key in ACTUATOR_HIGH_RISK_COMMANDS:
            if not ref:
                return self._result(False, "authorization_required", key, ref, at)
            if not authorization_ref_valid(ref):
                return self._result(False, "authorization_ref_invalid", key, ref, at)
        state = self._state()
        if state.state == "fault" and key not in ("clear_fault", "stop"):
            return self._result(False, f"device_fault:{state.fault_code or 'unknown'}", key, ref, at)
        command = ActuatorCommand(
            device_id=self.device_id,
            command_key=key,
            authorization_ref=ref,
            payload=dict(payload or {}),
            requested_at=at,
        )
        try:
            outcome: TransportResult = self.transport.send(command)
        except Exception as exc:  # 真实 Transport 故障：显式记录，不吞
            return self._result(False, f"transport_error:{type(exc).__name__}", key, ref, at)
        if not outcome.accepted:
            return self._result(False, outcome.reason or "transport_rejected", key, ref, at)
        delivered = self._frame(outcome.state or state)
        result = {
            "accepted": True,
            "reason": None,
            "device_id": self.device_id,
            "command_key": key,
            "authorization_ref": ref,
            "safety_command": is_safety,
            "at": at,
            "transport": self.transport.name,
            "state": delivered,
        }
        self.command_log.append(
            {
                "command_key": key,
                "authorization_ref": ref,
                "safety_command": is_safety,
                "accepted": True,
                "at": at,
            }
        )
        self._publish(delivered)
        return result

    def _result(self, accepted: bool, reason: str | None, key: str, ref: str | None, at: str) -> dict:
        if not accepted:
            self.command_log.append(
                {"command_key": key, "authorization_ref": ref, "accepted": False, "reason": reason, "at": at}
            )
        return {
            "accepted": accepted,
            "reason": reason,
            "device_id": self.device_id,
            "command_key": key,
            "authorization_ref": ref,
            "at": at,
            "transport": self.transport.name,
            "state": self._frame(self._state()),
        }

    # ---- 内部 ----
    def _state(self) -> ActuatorState:
        if self._tick_on_read:
            self.transport.tick()  # type: ignore[attr-defined]
        state = self.transport.recv(timeout=0) or self._last_state or ActuatorState(device_id=self.device_id)
        self._last_state = state
        self._last_seen = state.updated_at or now_iso()
        return state

    def _frame(self, state: ActuatorState) -> dict:
        frame = state.to_dict()
        frame.update(
            {
                "type": self.DEVICE_TYPE,
                "mode": "actuator",
                "source_type": self.source_type,
                "ts": state.updated_at or now_iso(),
                "station_id": self.station_id,
        # 统一帧契约：设备级/运动级/负荷级/业务级四段（与 exo_semantic 同一约定，
        # 真实 Transport 只填数值，不泄漏厂商字段名）。
                "device": {
                    "battery_pct": state.battery_pct,
                    "fault_code": state.fault_code,
                    "online": self._running,
                },
                "motion": {"x": state.x, "y": state.y, "state": state.state},
                "business": {
                    "current_task_id": state.current_task_id,
                    "target_station_id": state.target_station_id,
                    "last_authorization_ref": state.last_authorization_ref,
                },
            }
        )
        return frame

    def _publish(self, frame: dict) -> None:
        """把状态帧放进本地 inbox，供 manager 读取循环上行（队列满只记丢帧，不阻塞命令）。"""
        try:
            self._inbox.put_nowait(frame)
        except queue.Full:
            self.record_dropped_frame("actuator_inbox_full")
