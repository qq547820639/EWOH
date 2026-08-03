"""Modbus TCP connector surface (Final 5.0 AA-05).

Implements register/data-point normalization and a BaseAdapter-compatible edge
adapter for Modbus TCP. A real transport driver feeds normalized raw
dictionaries into ``_enqueue_raw``.
"""

from __future__ import annotations

import queue
from dataclasses import dataclass
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso

SUPPORTED_FUNCTIONS = {1, 2, 3, 4}


class ModbusError(ValueError):
    """Raised when a Modbus data point violates the connector contract."""


@dataclass
class ModbusRegister:
    """A Modbus register/coil address plus optional scaling."""

    address: int
    function_code: int
    scale: float = 1.0
    data_type: str = "int16"


def parse_modbus_register(
    address: Any,
    function_code: Any = 3,
    scale: Any = 1.0,
    data_type: str = "int16",
) -> ModbusRegister:
    """Validate a Modbus register definition."""
    try:
        parsed_address = int(address)
        parsed_function = int(function_code)
        parsed_scale = float(scale)
    except (TypeError, ValueError) as exc:
        raise ModbusError("register address/function/scale must be numeric") from exc
    if parsed_address < 0 or parsed_address > 65_535:
        raise ModbusError(f"register address out of range: {parsed_address}")
    if parsed_function not in SUPPORTED_FUNCTIONS:
        raise ModbusError(f"unsupported Modbus function code: {parsed_function}")
    return ModbusRegister(
        address=parsed_address,
        function_code=parsed_function,
        scale=parsed_scale,
        data_type=data_type,
    )


def normalize_modbus_datapoint(
    raw: dict[str, Any],
    default_entity_id: str = "",
    default_source_type: str = "real",
) -> dict[str, Any]:
    """Convert a Modbus register read to the EWOH telemetry envelope."""
    if not isinstance(raw, dict):
        raise ModbusError("Modbus data point must be an object")
    address_value = raw.get("registerAddress")
    if address_value is None:
        address_value = raw.get("address")
    function_value = raw.get("functionCode")
    if function_value is None:
        function_value = raw.get("function")
    register = parse_modbus_register(
        address_value,
        function_value,
        raw.get("scale", 1.0),
        str(raw.get("dataType") or "int16"),
    )
    if "value" not in raw:
        raise ModbusError("Modbus data point requires value")
    entity_id = str(raw.get("entityId") or default_entity_id or f"modbus:{register.address}")
    value = raw["value"]
    scaled_value = None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        scaled_value = value * register.scale
    return {
        "entity_id": entity_id,
        "register_address": register.address,
        "function_code": register.function_code,
        "data_type": register.data_type,
        "value": value,
        "scaled_value": scaled_value,
        "unit": raw.get("unit"),
        "metric_name": raw.get("metricName") or raw.get("name") or f"reg{register.address}",
        "quality_status": raw.get("qualityStatus") or "good",
        "event_time": raw.get("sourceTimestamp") or raw.get("ts") or now_iso(),
        "source_type": default_source_type,
        "protocol_version": "Modbus-TCP",
    }


class ModbusAdapter(BaseAdapter):
    """Edge adapter converting Modbus register reads to EWOH telemetry frames."""

    DEVICE_TYPE = "modbus_connector"

    def __init__(
        self,
        device_id: str,
        host: str,
        port: int = 502,
        unit_id: int = 1,
        source_type: str = "real",
        model: str = "MODBUS-TCP-GENERIC",
    ):
        super().__init__(
            device_id,
            source_type=source_type,
            model=model,
            firmware_version="Modbus-TCP",
        )
        self.host = host
        self.port = int(port)
        self.unit_id = int(unit_id)
        self._inbox: queue.Queue = queue.Queue(maxsize=1024)
        self._last_msg: dict[str, Any] | None = None
        self._last_seen: str | None = None

    def start(self) -> None:
        self._running = True
        self._started_at = now_iso()

    def stop(self) -> None:
        self._running = False

    def reconnect(self) -> bool:
        self._running = True
        return True

    def health(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
            "endpoint": f"{self.host}:{self.port}",
            "unit_id": self.unit_id,
        }

    def device_info(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "host": self.host,
            "port": self.port,
            "unit_id": self.unit_id,
        }

    def read_message(self, timeout=None) -> dict[str, Any] | None:
        try:
            msg = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        self._last_msg = msg
        self._last_seen = msg.get("event_time")
        return msg

    def _enqueue_raw(self, raw: dict[str, Any]) -> None:
        """Normalize and enqueue one Modbus register read (driver callback)."""
        msg = normalize_modbus_datapoint(raw, default_source_type=self.source_type)
        try:
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass
