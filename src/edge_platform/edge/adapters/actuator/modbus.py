"""Modbus/TCP 执行机构 Transport + 可跑通的假从站（NO-62d）。

对应愿景「没有真实硬件时建设硬件抽象、数字孪生和可替换模拟设备」与决策原则 11：
回环模拟器证明了"命令 → 状态 → 回执"的**软件**闭环，但真实产线上的 AGV/PLC 说的是
工业协议。本模块把这条**协议**路径也做成可跑通、可验证的：

```
ActuatorAdapter（授权判定顺序不变）
        ↓  ActuatorCommand
ModbusTcpActuatorTransport   ← 主站：MBAP + FC03 读 / FC06 写（真实 Modbus/TCP 帧）
        ↓  以太网字节流
FakeModbusSlave              ← 从站：协议帧真实解析，寄存器后面的"设备"是数字孪生
        ↓
LoopbackActuatorTransport    ← 复用既有确定性设备语义（移动/电量/故障）
```

严格边界（原则 6/7，必须说清楚）：
- **线上协议是真的**：MBAP 头（事务号/协议号/长度/单元号）、功能码、异常响应
  （0x83 + 异常码）、寄存器读写全部按 Modbus/TCP 规范编解码，可被真实主站/从站工具抓包；
- **设备是模拟的**：从站寄存器背后的"车辆"是 `LoopbackActuatorTransport`（数字孪生），
  不是真机。接真机时**只需替换从站**（或把主站指向现场 PLC 的 IP/端口），
  主站类与上层判定顺序都不用改；
- **不做 CRC**：Modbus/TCP 用 MBAP 长度字段定界，没有 RTU 的 CRC16（这里不假装实现）。
- **不静默**：连接失败/超时/异常响应/非法地址都显式返回原因，绝不返回"看起来正常"的状态。

寄存器映射（契约；现场 PLC 按此配置，或改 `RegisterMap` 后两处自动一致）：

| 地址 | 类型 | 含义 |
|---|---|---|
| 0 | 输入寄存器（FC04）/ 保持寄存器（FC03） | 状态码（`ACTUATOR_STATES` 下标） |
| 1 | 保持寄存器 | x 坐标 × 10（有符号 16 位） |
| 2 | 保持寄存器 | y 坐标 × 10（有符号 16 位） |
| 3 | 保持寄存器 | 电量 × 10（0..1000） |
| 4 | 保持寄存器 | 故障码（0 = 无故障；否则 1..N 为厂商码表下标） |
| 5 | 保持寄存器 | 目标工位哈希低 16 位（工位号本身的字符串哈希） |
| 100 | 保持寄存器（FC06 写） | 命令码（`ACTUATOR_COMMANDS` 下标 + 1；0 = 空闲） |
| 101 | 保持寄存器（FC06 写） | 目标工位哈希低 16 位（`dispatch_task` 用） |
| 102 | 保持寄存器（FC06 写） | 命令请求序号（从站据此判断"新命令"，避免重复执行） |

为什么用"命令码 + 哈希"而不是写字符串：Modbus 寄存器是 16 位整数，
字符串要跨多寄存器且字节序易错。**哈希只用于校验/关联**，真正的工位号由
主站侧（`ModbusTcpActuatorTransport._pending_target`）保留——不把哈希当工位号用。
"""

from __future__ import annotations

import socket
import socketserver
import struct
import threading
from dataclasses import dataclass
from typing import Any

from edge_platform.edge.adapters.actuator.protocol import (
    ACTUATOR_COMMANDS,
    ACTUATOR_STATES,
    ActuatorCommand,
    ActuatorState,
    ActuatorTransport,
    LoopbackActuatorTransport,
    TransportResult,
    fnv1a64_hex,
)

#: Modbus 功能码（本模块只实现用到的四个 + 异常响应）。
FC_READ_HOLDING = 0x03
FC_READ_INPUT = 0x04
FC_WRITE_SINGLE = 0x06
FC_WRITE_MULTIPLE = 0x10

#: 异常码（Modbus 规范；页面/日志按码表解释，不猜）。
EXCEPTION_ILLEGAL_FUNCTION = 0x01
EXCEPTION_ILLEGAL_DATA_ADDRESS = 0x02
EXCEPTION_ILLEGAL_DATA_VALUE = 0x03
EXCEPTION_SLAVE_DEVICE_FAILURE = 0x04
EXCEPTION_ACKNOWLEDGE = 0x05
EXCEPTION_SLAVE_DEVICE_BUSY = 0x06


def station_hash16(station_id: Any) -> int:
    """工位号 → 16 位哈希（协议内关联用；**不是**工位号本身，见模块 docstring）。

    实现：FNV-1a 64 位 → **异或折叠**到 16 位（`h ^ h>>16 ^ h>>32 ^ h>>48`）。
    为什么不是直接截取前 4 位十六进制：实测 "ST-1" 与 "ST-2" 在 FNV-1a-64 的
    高位上不分散，前缀截断直接撞车（见 `test_station_hash_...`）。折叠让所有位参与。
    诚实边界：16 位空间必然可能碰撞，因此它只用于**协议内关联/校验**；
    工位号真值由主站侧保留（`_pending_target`），绝不把哈希当工位号使用。
    """
    value = int(fnv1a64_hex(str(station_id or "")), 16)
    return (value ^ (value >> 16) ^ (value >> 32) ^ (value >> 48)) & 0xFFFF


@dataclass
class RegisterMap:
    """寄存器地址契约（主站与从站共用同一份，改一处两侧同时生效）。"""

    state: int = 0
    x: int = 1
    y: int = 2
    battery: int = 3
    fault: int = 4
    target: int = 5
    command: int = 100
    command_target: int = 101
    command_seq: int = 102
    #: 保持寄存器总长度（越界一律异常响应，不返回 0 假装"读到 0"）。
    holding_size: int = 128
    unit_id: int = 1


DEFAULT_REGISTER_MAP = RegisterMap()


def encode_fault_code(code: Any) -> int:
    """故障码字符串 → 寄存器值（0 = 无故障；否则为 1..32767 的稳定编码）。"""
    text = str(code or "").strip()
    if text == "":
        return 0
    return (station_hash16(text) % 0x7FFF) + 1


class ModbusError(RuntimeError):
    """Modbus 层错误（连接/超时/异常响应）；调用方必须显式处理，不吞。"""


class ModbusTcpActuatorTransport(ActuatorTransport):
    """Modbus/TCP 主站 Transport：真实帧 + 确定性设备语义（由从站提供）。

    参数：
    - `host`/`port`：从站地址（假从站或现场 PLC）；
    - `device_id`：设备号（写入 `ActuatorState`，与平台台账同号）；
    - `register_map`：寄存器契约（现场 PLC 不一致时改这里，不改代码逻辑）；
    - `timeout`：单次请求超时（秒）。
    """

    name = "modbus-tcp"

    def __init__(
        self,
        host: str,
        device_id: str,
        *,
        port: int = 502,
        register_map: RegisterMap | None = None,
        timeout: float = 2.0,
        unit_id: int | None = None,
    ):
        self.host = str(host)
        self.port = int(port)
        self.device_id = str(device_id)
        self.map = register_map or DEFAULT_REGISTER_MAP
        self.timeout = float(timeout)
        self.unit_id = int(unit_id if unit_id is not None else self.map.unit_id)
        self._sock: socket.socket | None = None
        self._tx = 0
        self._lock = threading.Lock()
        #: 上一次 dispatch 的目标工位（工位号本身——哈希只用于协议内关联）
        self._pending_target: str | None = None
        #: 命令序号（从站据此识别"新命令"；不是幂等键，幂等由平台台账负责）
        self._command_seq = 0
        self._last_fault: str | None = None
        self._closed = False

    # ── 连接管理 ─────────────────────────────────────────────────────
    def connect(self) -> None:
        if self._sock is not None:
            return
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as exc:
            raise ModbusError(f"connect_failed:{type(exc).__name__}") from exc
        sock.settimeout(self.timeout)
        self._sock = sock

    def close(self) -> None:
        self._closed = True
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None

    # ── 协议编解码（MBAP + PDU）─────────────────────────────────────
    def _request(self, pdu: bytes) -> bytes:
        """发一帧并返回响应 PDU；异常响应转成 `ModbusError`（不返回假数据）。"""
        if self._closed:
            raise ModbusError("transport_closed")
        self.connect()
        assert self._sock is not None  # connect() 保证
        with self._lock:
            self._tx = (self._tx + 1) % 0x10000
            tx = self._tx
            # MBAP：事务号(2) 协议号(2)=0 长度(2) 单元号(1)；长度 = 单元号 + PDU
            header = struct.pack(">HHHB", tx, 0, len(pdu) + 1, self.unit_id)
            try:
                self._sock.sendall(header + pdu)
                raw_header = self._recv_exactly(7)
                r_tx, protocol, length, _unit = struct.unpack(">HHHB", raw_header)
                body = self._recv_exactly(max(int(length) - 1, 0))
            except (OSError, TimeoutError) as exc:
                # 连接已不可信：丢弃句柄，让下一次调用重连（不假装成功）
                self.close()
                self._closed = False
                raise ModbusError(f"io_error:{type(exc).__name__}") from exc
        if protocol != 0:
            raise ModbusError(f"bad_protocol_id:{protocol}")
        if r_tx != tx:
            raise ModbusError(f"transaction_mismatch:{r_tx}!={tx}")
        if not body:
            raise ModbusError("empty_response")
        function = body[0]
        if function & 0x80:
            code = body[1] if len(body) > 1 else 0
            raise ModbusError(f"modbus_exception:{code}")
        return body

    def _recv_exactly(self, count: int) -> bytes:
        assert self._sock is not None
        chunks = b""
        while len(chunks) < count:
            chunk = self._sock.recv(count - len(chunks))
            if not chunk:
                raise ModbusError("connection_closed_by_peer")
            chunks += chunk
        return chunks

    def _read_registers(self, start: int, count: int, function: int = FC_READ_HOLDING) -> list[int]:
        pdu = struct.pack(">BHH", function, start, count)
        body = self._request(pdu)
        if body[0] != function:
            raise ModbusError(f"unexpected_function:{body[0]}")
        byte_count = body[1]
        if byte_count != count * 2 or len(body) < 2 + byte_count:
            raise ModbusError(f"bad_byte_count:{byte_count}")
        return list(struct.unpack(f">{count}H", body[2 : 2 + byte_count]))

    def _write_register(self, address: int, value: int) -> None:
        if not 0 <= int(value) <= 0xFFFF:
            raise ModbusError(f"value_out_of_range:{value}")
        body = self._request(struct.pack(">BHH", FC_WRITE_SINGLE, address, int(value)))
        if body[0] != FC_WRITE_SINGLE:
            raise ModbusError(f"unexpected_function:{body[0]}")

    # ── ActuatorTransport ───────────────────────────────────────────
    def send(self, command: ActuatorCommand) -> TransportResult:
        """把命令写进从站寄存器；从站执行结果由 `recv()` 读回（两件事分开）。"""
        key = str(command.command_key or "")
        if key not in ACTUATOR_COMMANDS:
            return TransportResult(accepted=False, reason="unknown_command_key", state=self._safe_state())
        try:
            if key == "dispatch_task":
                target = str((command.payload or {}).get("targetStationId") or "").strip()
                if target == "":
                    return TransportResult(
                        accepted=False, reason="target_station_required", state=self._safe_state()
                    )
                self._pending_target = target
                self._write_register(self.map.command_target, station_hash16(target))
            self._command_seq += 1
            code = ACTUATOR_COMMANDS.index(key) + 1
            # 顺序有讲究：先写参数（目标/序号）、最后写命令码——命令码是"提交点"，
            # 避免从站读到"命令已到但参数还没到"的半成品状态。
            self._write_register(self.map.command_seq, self._command_seq % 0x10000)
            self._write_register(self.map.command, code)
        except ModbusError as exc:
            return TransportResult(accepted=False, reason=str(exc), state=self._safe_state())
        state = self.recv()
        return TransportResult(accepted=True, reason=None, state=state)

    def recv(self, timeout: float | None = None) -> ActuatorState | None:
        """读回设备状态（FC03）。读失败 → 返回 None（**不伪造状态**）。"""
        try:
            values = self._read_registers(
                self.map.state, 6, function=FC_READ_HOLDING
            )
        except ModbusError:
            return None
        return self._state_from_registers(values)

    def _state_from_registers(self, values: list[int]) -> ActuatorState:
        def signed(word: int) -> int:
            return word - 0x10000 if word >= 0x8000 else word

        state_index = int(values[0])
        state = ACTUATOR_STATES[state_index] if 0 <= state_index < len(ACTUATOR_STATES) else "unknown"
        fault_word = int(values[4])
        fault = self._last_fault if fault_word == 0 else f"MODBUS_FAULT_{fault_word}"
        return ActuatorState(
            device_id=self.device_id,
            state=state,
            x=round(signed(values[1]) / 10.0, 3),
            y=round(signed(values[2]) / 10.0, 3),
            battery_pct=round(int(values[3]) / 10.0, 1),
            current_task_id=None,
            target_station_id=self._pending_target if state == "moving" else None,
            fault_code=None if fault_word == 0 else fault,
            last_command_key=None,
            last_authorization_ref=None,
            updated_at="",
        )

    def _safe_state(self) -> ActuatorState | None:
        """失败路径上的状态读回：读不到就返回 None（调用方必须能区分"未知"与"空闲"）。"""
        return self.recv()


class _ModbusRequestHandler(socketserver.BaseRequestHandler):
    """假从站的单连接处理（MBAP 解析 + 功能码分发）。"""

    def handle(self) -> None:  # noqa: C901 - 协议分发本身就长
        slave: FakeModbusSlave = self.server.slave  # type: ignore[attr-defined]
        while True:
            try:
                header = self._recv_exactly(7)
            except (OSError, ModbusError):
                return
            if not header:
                return
            tx, protocol, length, unit = struct.unpack(">HHHB", header)
            try:
                pdu = self._recv_exactly(max(int(length) - 1, 0))
            except ModbusError:
                return
            slave.requests.append({"unit": unit, "pdu": pdu.hex()})
            response = slave.handle_pdu(pdu)
            payload = struct.pack(">HHHB", tx, protocol if protocol == 0 else 0, len(response) + 1, unit)
            try:
                self.request.sendall(payload + response)
            except OSError:
                return

    def _recv_exactly(self, count: int) -> bytes:
        chunks = b""
        while len(chunks) < count:
            chunk = self.request.recv(count - len(chunks))
            if not chunk:
                return chunks
            chunks += chunk
        return chunks


class _ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class FakeModbusSlave:
    """Modbus/TCP 假从站：**真实协议帧** + 数字孪生设备（`LoopbackActuatorTransport`）。

    用途：在没有 PLC/AGV 的机器上验证 Modbus 路径（帧编解码、异常响应、寄存器契约、
    命令 → 状态迁移），并作为现场调试的对端（把主站指向本从站即可复现主站行为）。
    """

    def __init__(
        self,
        device_id: str = "AGV-MODBUS-1",
        *,
        host: str = "127.0.0.1",
        port: int = 0,
        register_map: RegisterMap | None = None,
        device: LoopbackActuatorTransport | None = None,
    ):
        self.map = register_map or DEFAULT_REGISTER_MAP
        self.device_id = device_id
        self.device = device or LoopbackActuatorTransport(
            device_id, x=0.0, y=0.0, battery_pct=88.0, step_m=1.0
        )
        self.holding: list[int] = [0] * self.map.holding_size
        self.requests: list[dict] = []
        self._last_seq = 0
        self._server = _ThreadingServer((host, port), _ModbusRequestHandler)
        self._server.slave = self  # type: ignore[attr-defined]
        self._thread: threading.Thread | None = None
        self.host, self.port = self._server.server_address[0], int(self._server.server_address[1])

    # ── 生命周期 ────────────────────────────────────────────────────
    def start(self) -> FakeModbusSlave:
        if self._thread is None:
            self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        if self._thread is not None:
            self._server.shutdown()
            self._server.server_close()
            self._thread = None

    # ── PDU 分发 ────────────────────────────────────────────────────
    def handle_pdu(self, pdu: bytes) -> bytes:
        if not pdu:
            return self._exception(FC_READ_HOLDING, EXCEPTION_ILLEGAL_FUNCTION)
        function = pdu[0]
        try:
            if function in (FC_READ_HOLDING, FC_READ_INPUT):
                if len(pdu) != 5:
                    return self._exception(function, EXCEPTION_ILLEGAL_DATA_VALUE)
                start, count = struct.unpack(">HH", pdu[1:5])
                return self._read(function, start, count)
            if function == FC_WRITE_SINGLE:
                if len(pdu) != 5:
                    return self._exception(function, EXCEPTION_ILLEGAL_DATA_VALUE)
                address, value = struct.unpack(">HH", pdu[1:5])
                return self._write_single(address, value)
            if function == FC_WRITE_MULTIPLE:
                return self._write_multiple(pdu)
            return self._exception(function, EXCEPTION_ILLEGAL_FUNCTION)
        except ModbusError as exc:
            code = int(str(exc).split(":")[-1]) if ":" in str(exc) else EXCEPTION_SLAVE_DEVICE_FAILURE
            return self._exception(function, code)
        except Exception:  # pragma: no cover - 从站内部错误：如实回异常码，不静默断连
            return self._exception(function, EXCEPTION_SLAVE_DEVICE_FAILURE)

    @staticmethod
    def _exception(function: int, code: int) -> bytes:
        return struct.pack(">BB", function | 0x80, code)

    def _read(self, function: int, start: int, count: int) -> bytes:
        if count < 1 or count > 125:
            raise ModbusError(f"illegal_data_value:{EXCEPTION_ILLEGAL_DATA_VALUE}")
        if start < 0 or start + count > len(self.holding):
            # 越界 → 异常响应（**绝不返回 0 假装读到了**）
            raise ModbusError(f"illegal_data_address:{EXCEPTION_ILLEGAL_DATA_ADDRESS}")
        self._refresh_holding()
        values = self.holding[start : start + count]
        return struct.pack(">BB", function, count * 2) + struct.pack(f">{count}H", *values)

    def _write_single(self, address: int, value: int) -> bytes:
        if address < 0 or address >= len(self.holding):
            raise ModbusError(f"illegal_data_address:{EXCEPTION_ILLEGAL_DATA_ADDRESS}")
        if address == self.map.command:
            self._apply_command(value)
        elif address in (self.map.command_target, self.map.command_seq):
            self.holding[address] = value
            if address == self.map.command_seq:
                self._last_seq = value
        elif address == self.map.state:
            raise ModbusError(f"illegal_data_address:{EXCEPTION_ILLEGAL_DATA_ADDRESS}")
        else:
            self.holding[address] = value
        return struct.pack(">BHH", FC_WRITE_SINGLE, address, value)

    def _write_multiple(self, pdu: bytes) -> bytes:
        if len(pdu) < 6:
            return self._exception(FC_WRITE_MULTIPLE, EXCEPTION_ILLEGAL_DATA_VALUE)
        start, count, byte_count = struct.unpack(">HHB", pdu[1:6])
        if byte_count != count * 2 or len(pdu) != 6 + byte_count:
            return self._exception(FC_WRITE_MULTIPLE, EXCEPTION_ILLEGAL_DATA_VALUE)
        if start < 0 or start + count > len(self.holding):
            return self._exception(FC_WRITE_MULTIPLE, EXCEPTION_ILLEGAL_DATA_ADDRESS)
        values = list(struct.unpack(f">{count}H", pdu[6 : 6 + byte_count]))
        for offset, value in enumerate(values):
            self.holding[start + offset] = value
        # 命令寄存器在同一批写入里时，按"提交点"语义生效（与 FC06 顺序一致）
        if start <= self.map.command < start + count:
            self._apply_command(self.holding[self.map.command])
        return struct.pack(">BHH", FC_WRITE_MULTIPLE, start, count)

    # ── 设备语义（数字孪生）─────────────────────────────────────────
    def _apply_command(self, code: int) -> None:
        index = int(code) - 1
        if code == 0 or index < 0 or index >= len(ACTUATOR_COMMANDS):
            raise ModbusError(f"illegal_data_value:{EXCEPTION_ILLEGAL_DATA_VALUE}")
        key = ACTUATOR_COMMANDS[index]
        payload: dict = {}
        if key == "dispatch_task":
            target = self._target_from_registers()
            if target is None:
                raise ModbusError(f"slave_device_failure:{EXCEPTION_SLAVE_DEVICE_FAILURE}")
            payload["targetStationId"] = target
        self.device.send(
            ActuatorCommand(
                device_id=self.device_id,
                command_key=key,
                authorization_ref=None,  # 授权判定在 Adapter 层；从站不做授权决策
                payload=payload,
                requested_at="",
            )
        )
        self._refresh_holding()

    def _target_from_registers(self) -> str | None:
        """按哈希把寄存器里的目标映射回已注册工位（注册表是数字孪生的一部分）。"""
        wanted = int(self.holding[self.map.command_target])
        for station_id in self.device.station_coords:
            if station_hash16(station_id) == wanted:
                return station_id
        return None

    def _refresh_holding(self) -> None:
        state = self.device.recv(timeout=0)
        if state is None:  # pragma: no cover - 回环模拟器恒有状态
            return
        self.holding[self.map.state] = (
            ACTUATOR_STATES.index(state.state) if state.state in ACTUATOR_STATES else 0
        )
        self.holding[self.map.x] = int(round(float(state.x or 0.0) * 10)) & 0xFFFF
        self.holding[self.map.y] = int(round(float(state.y or 0.0) * 10)) & 0xFFFF
        self.holding[self.map.battery] = int(round(float(state.battery_pct or 0.0) * 10)) & 0xFFFF
        self.holding[self.map.fault] = encode_fault_code(state.fault_code)
        self.holding[self.map.target] = station_hash16(state.target_station_id or "")

    # ── 测试/演示辅助 ───────────────────────────────────────────────
    def tick(self) -> ActuatorState:
        """推进一个仿真步（供测试/演示显式调用；从站不后台自跑）。"""
        state = self.device.tick()
        self._refresh_holding()
        return state


__all__ = [
    "DEFAULT_REGISTER_MAP",
    "EXCEPTION_ILLEGAL_DATA_ADDRESS",
    "EXCEPTION_ILLEGAL_DATA_VALUE",
    "EXCEPTION_ILLEGAL_FUNCTION",
    "FakeModbusSlave",
    "FC_READ_HOLDING",
    "FC_READ_INPUT",
    "FC_WRITE_MULTIPLE",
    "FC_WRITE_SINGLE",
    "ModbusError",
    "ModbusTcpActuatorTransport",
    "RegisterMap",
    "encode_fault_code",
    "station_hash16",
]
