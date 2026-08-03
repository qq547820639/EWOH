"""OPC UA connector codec and adapter (Final 5.0 AA-05).

Implements the EWOH-side protocol surface for OPC UA without requiring an OPC
UA SDK: node ID parsing, data point normalization, quality mapping, and a
BaseAdapter-compatible edge adapter. Real binary/UA-TCP transport is delegated
to a driver that feeds normalized raw dictionaries into ``_enqueue_raw``.
"""

from __future__ import annotations

import queue
from dataclasses import dataclass
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso

GOOD_QUALITY_CODES = {"Good", "GoodNonCritical", "GoodLocalOverride"}
BAD_QUALITY_CODES = {"Bad", "BadOutOfService", "BadNoCommunication"}


class OpcUaError(ValueError):
    """Base error for OPC UA connector parsing."""


@dataclass
class OpcUaNodeId:
    """Parsed OPC UA node ID."""

    namespace: int
    identifier_type: str
    identifier: str


def parse_opcua_node_id(node_id: str) -> OpcUaNodeId:
    """Parse an OPC UA node ID string like ``ns=2;i=85`` or ``ns=2;s=temp``."""
    if not isinstance(node_id, str) or not node_id:
        raise OpcUaError("nodeId must be a non-empty string")
    parts = node_id.split(";")
    namespace = 0
    identifier = None
    identifier_type = "i"
    for part in parts:
        if part.startswith("ns="):
            try:
                namespace = int(part[3:])
            except ValueError as exc:
                raise OpcUaError(f"invalid namespace in nodeId {node_id}") from exc
        elif part.startswith(("i=", "s=", "g=", "b=")):
            identifier_type = part[0]
            identifier = part[2:]
    if identifier is None or identifier == "":
        raise OpcUaError(f"nodeId has no identifier: {node_id}")
    return OpcUaNodeId(
        namespace=namespace,
        identifier_type=identifier_type,
        identifier=identifier,
    )


def map_quality(quality_code: str | None) -> str:
    """Map OPC UA quality codes to EWOH data quality status."""
    if quality_code in GOOD_QUALITY_CODES:
        return "good"
    if quality_code in BAD_QUALITY_CODES or (quality_code and quality_code.startswith("Bad")):
        return "degraded"
    return "unknown"


def normalize_opcua_datapoint(
    raw: dict[str, Any],
    default_entity_id: str = "",
    default_source_type: str = "real",
) -> dict[str, Any]:
    """Convert an OPC UA data point to the EWOH telemetry envelope."""
    if not isinstance(raw, dict):
        raise OpcUaError("OPC UA data point must be an object")
    node_id = raw.get("nodeId") or raw.get("node_id")
    if not node_id:
        raise OpcUaError("OPC UA data point requires nodeId")
    parsed = parse_opcua_node_id(str(node_id))
    entity_id = str(raw.get("entityId") or default_entity_id or parsed.identifier)
    event_time = raw.get("sourceTimestamp") or raw.get("ts") or now_iso()
    quality_code = raw.get("qualityCode") or raw.get("quality")
    quality_status = map_quality(str(quality_code) if quality_code is not None else None)
    return {
        "entity_id": entity_id,
        "node_id": str(node_id),
        "namespace": parsed.namespace,
        "identifier_type": parsed.identifier_type,
        "identifier": parsed.identifier,
        "metric_name": raw.get("metricName") or raw.get("name") or parsed.identifier,
        "value": raw.get("value"),
        "data_type": raw.get("dataType") or "Any",
        "unit": raw.get("unit"),
        "quality_code": quality_code,
        "quality_status": quality_status,
        "event_time": event_time,
        "source_type": default_source_type,
        "protocol_version": "OPC-UA",
    }


class OpcUaAdapter(BaseAdapter):
    """Edge adapter converting OPC UA data points to EWOH telemetry frames."""

    DEVICE_TYPE = "opcua_connector"

    def __init__(
        self,
        device_id: str,
        endpoint_url: str,
        source_type: str = "real",
        model: str = "OPC-UA-GENERIC",
    ):
        super().__init__(
            device_id,
            source_type=source_type,
            model=model,
            firmware_version="OPC-UA",
        )
        self.endpoint_url = endpoint_url
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
            "endpoint_url": self.endpoint_url,
        }

    def device_info(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "endpoint_url": self.endpoint_url,
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
        """Normalize and enqueue one OPC UA data point (driver callback)."""
        msg = normalize_opcua_datapoint(raw, default_source_type=self.source_type)
        try:
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass
