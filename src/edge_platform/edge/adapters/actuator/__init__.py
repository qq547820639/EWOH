"""执行机构适配器包（NO-59b）：AGV/PLC 的协议面 + 回环模拟器。

导出 `ActuatorAdapter`（适配器）、`LoopbackActuatorTransport`（无硬件模拟）、
以及统一状态/命令契约类型。
"""

from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter
from edge_platform.edge.adapters.actuator.modbus import (
    FakeModbusSlave,
    ModbusError,
    ModbusTcpActuatorTransport,
    RegisterMap,
    station_hash16,
)
from edge_platform.edge.adapters.actuator.protocol import (
    ACTUATOR_COMMAND_PRIORITY,
    ACTUATOR_COMMANDS,
    ACTUATOR_HIGH_RISK_COMMANDS,
    ACTUATOR_SAFETY_COMMANDS,
    ACTUATOR_STATES,
    AUTHORIZATION_FINGERPRINT_ALGO,
    AUTHORIZATION_REF_PREFIXES,
    UNKNOWN_COMMAND_PRIORITY,
    ActuatorCommand,
    ActuatorState,
    ActuatorTransport,
    LoopbackActuatorTransport,
    TransportResult,
    authorization_fingerprint,
    authorization_ref_valid,
    canonical_json,
    command_priority,
    fnv1a64_hex,
)

__all__ = [
    "ACTUATOR_COMMAND_PRIORITY",
    "ACTUATOR_COMMANDS",
    "ACTUATOR_HIGH_RISK_COMMANDS",
    "ACTUATOR_SAFETY_COMMANDS",
    "ACTUATOR_STATES",
    "AUTHORIZATION_FINGERPRINT_ALGO",
    "AUTHORIZATION_REF_PREFIXES",
    "UNKNOWN_COMMAND_PRIORITY",
    "ActuatorAdapter",
    "ActuatorCommand",
    "ActuatorState",
    "ActuatorTransport",
    "FakeModbusSlave",
    "ModbusError",
    "ModbusTcpActuatorTransport",
    "RegisterMap",
    "station_hash16",
    "LoopbackActuatorTransport",
    "TransportResult",
    "authorization_fingerprint",
    "authorization_ref_valid",
    "canonical_json",
    "command_priority",
    "fnv1a64_hex",
]
