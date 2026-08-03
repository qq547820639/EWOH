"""Sparkplug B connector codec and adapter (Final 5.0 AA-06).

Implements the Sparkplug B MQTT topic namespace, a minimal pure-Python protobuf
decoder for the Sparkplug payload wire format used by NBIRTH/DBIRTH/NDATA/DDATA
and death messages, plus session/sequence tracking. The adapter emits the
EWOH canonical telemetry envelope so Sparkplug vendor fields do not leak into
upper layers.
"""

from __future__ import annotations

import queue
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso

SPARKPLUG_NAMESPACE = "spBv1.0"
SPARKPLUG_MESSAGE_TYPES = (
    "NBIRTH",
    "NDEATH",
    "DBIRTH",
    "DDEATH",
    "NDATA",
    "DDATA",
    "NCMD",
    "DCMD",
    "STATE",
)

DATATYPE_NAMES = {
    0: "Int8",
    1: "Int16",
    2: "Int32",
    3: "Int64",
    4: "UInt8",
    5: "UInt16",
    6: "UInt32",
    7: "UInt64",
    8: "Float",
    9: "Double",
    10: "Boolean",
    11: "String",
    12: "DateTime",
    13: "Text",
    14: "UUID",
    15: "DataSet",
    16: "Template",
    17: "PropertySet",
    18: "PropertySetList",
    19: "Bytes",
    20: "File",
    21: "Path",
    22: "Reference",
    23: "Any",
    24: "JSON",
    25: "XML",
    26: "Node",
    27: "Edge",
    28: "DateTime",
}


class SparkplugError(ValueError):
    """Base error for Sparkplug B parsing."""


class SparkplugTopicError(SparkplugError):
    """Raised when a topic violates the Sparkplug B namespace contract."""


class SparkplugCodecError(SparkplugError):
    """Raised when a payload is not decodable as Sparkplug B protobuf."""


@dataclass
class SparkplugTopic:
    """Parsed Sparkplug B topic."""

    namespace: str
    group_id: str
    message_type: str
    edge_node_id: str
    device_id: str | None = None


def parse_sparkplug_topic(topic: str) -> SparkplugTopic:
    """Parse a Sparkplug B topic into its canonical parts.

    Primary host STATE topics use ``spBv1.0/STATE/online``; device topics use
    ``spBv1.0/<group>/<type>/<edge>/<device>``.
    """
    if not isinstance(topic, str) or not topic:
        raise SparkplugTopicError("topic must be a non-empty string")
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == SPARKPLUG_NAMESPACE and parts[1] == "STATE":
        if parts[2] not in ("online", "offline"):
            raise SparkplugTopicError(f"invalid STATE topic: {topic}")
        return SparkplugTopic(
            namespace=SPARKPLUG_NAMESPACE,
            group_id="STATE",
            message_type="STATE",
            edge_node_id=parts[2],
        )
    if len(parts) < 4 or parts[0] != SPARKPLUG_NAMESPACE:
        raise SparkplugTopicError(f"topic must start with {SPARKPLUG_NAMESPACE}")
    message_type = parts[2].upper()
    if message_type not in SPARKPLUG_MESSAGE_TYPES:
        raise SparkplugTopicError(f"unknown Sparkplug message type: {parts[2]}")
    if message_type == "STATE":
        raise SparkplugTopicError("STATE topic must use the two-part form")
    if not parts[1] or not parts[3]:
        raise SparkplugTopicError("group_id and edge_node_id are required")
    device_id = parts[4] if len(parts) >= 5 and parts[4] else None
    return SparkplugTopic(
        namespace=SPARKPLUG_NAMESPACE,
        group_id=parts[1],
        message_type=message_type,
        edge_node_id=parts[3],
        device_id=device_id,
    )


@dataclass
class SparkplugMetric:
    """One decoded Sparkplug metric."""

    name: str
    datatype: int | None
    datatype_name: str | None
    value: Any = None
    alias: int | None = None
    timestamp_ms: int | None = None
    is_null: bool = False


@dataclass
class SparkplugPayload:
    """Decoded Sparkplug B payload."""

    timestamp_ms: int | None
    seq: int | None
    uuid: str | None
    body: bytes | None
    metrics: list[SparkplugMetric] = field(default_factory=list)


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise SparkplugCodecError("varint too long")
    raise SparkplugCodecError("truncated varint")


def _read_bytes(data: bytes, pos: int, length: int) -> tuple[bytes, int]:
    end = pos + length
    if end > len(data):
        raise SparkplugCodecError("truncated length-delimited field")
    return data[pos:end], end


def _decode_metric(data: bytes) -> SparkplugMetric:
    metric = SparkplugMetric(name="", datatype=None, datatype_name=None)
    pos = 0
    while pos < len(data):
        key, pos = _read_varint(data, pos)
        field_no = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, pos = _read_varint(data, pos)
            if field_no == 2:
                metric.alias = value
            elif field_no == 3:
                metric.timestamp_ms = value
            elif field_no == 4:
                metric.datatype = value
                metric.datatype_name = DATATYPE_NAMES.get(value, "Unknown")
            elif field_no == 7:
                metric.is_null = bool(value)
            elif field_no == 9:
                metric.value = value if value < 2**31 else value - 2**32
            elif field_no == 10:
                metric.value = value if value < 2**63 else value - 2**64
            elif field_no == 13:
                metric.value = bool(value)
        elif wire_type == 1:
            raw, pos = _read_bytes(data, pos, 8)
            if field_no == 12:
                metric.value = struct.unpack("<d", raw)[0]
        elif wire_type == 2:
            length, pos = _read_varint(data, pos)
            raw, pos = _read_bytes(data, pos, length)
            if field_no == 1:
                metric.name = raw.decode("utf-8", errors="replace")
            elif field_no == 14:
                metric.value = raw.decode("utf-8", errors="replace")
            elif field_no == 15:
                metric.value = raw
        elif wire_type == 5:
            raw, pos = _read_bytes(data, pos, 4)
            if field_no == 11:
                metric.value = struct.unpack("<f", raw)[0]
        else:
            raise SparkplugCodecError(f"unsupported wire type {wire_type}")
    return metric


def decode_sparkplug_payload(data: bytes) -> SparkplugPayload:
    """Decode a Sparkplug B protobuf payload without third-party dependencies."""
    if not isinstance(data, (bytes, bytearray)):
        raise SparkplugCodecError("payload must be bytes")
    payload = SparkplugPayload(
        timestamp_ms=None,
        seq=None,
        uuid=None,
        body=None,
        metrics=[],
    )
    pos = 0
    while pos < len(data):
        key, pos = _read_varint(data, pos)
        field_no = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, pos = _read_varint(data, pos)
            if field_no == 1:
                payload.timestamp_ms = value
            elif field_no == 2:
                payload.seq = value
        elif wire_type == 1:
            _, pos = _read_bytes(data, pos, 8)
        elif wire_type == 2:
            length, pos = _read_varint(data, pos)
            raw, pos = _read_bytes(data, pos, length)
            if field_no == 3:
                payload.uuid = raw.decode("utf-8", errors="replace")
            elif field_no == 4:
                payload.body = raw
            elif field_no == 5:
                payload.metrics.append(_decode_metric(raw))
        elif wire_type == 5:
            _, pos = _read_bytes(data, pos, 4)
        else:
            raise SparkplugCodecError(f"unsupported payload wire type {wire_type}")
    return payload


def _event_type(message_type: str) -> str:
    if message_type in ("NBIRTH", "DBIRTH"):
        return "DeviceBirth"
    if message_type in ("NDEATH", "DDEATH"):
        return "DeviceStateChanged"
    return "TelemetryObserved"


def normalize_sparkplug_message(
    topic: str,
    payload_bytes: bytes,
    source_type: str = "real",
) -> dict[str, Any]:
    """Convert a Sparkplug topic/payload pair into the EWOH telemetry envelope."""
    parsed_topic = parse_sparkplug_topic(topic)
    payload = decode_sparkplug_payload(payload_bytes)
    entity_id = parsed_topic.device_id or parsed_topic.edge_node_id
    event_time = (
        time.strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ",
            time.gmtime(payload.timestamp_ms / 1000),
        )
        if payload.timestamp_ms is not None
        else now_iso()
    )
    metrics = [
        {
            "name": metric.name,
            "alias": metric.alias,
            "datatype": metric.datatype_name,
            "value": metric.value,
            "is_null": metric.is_null,
            "timestamp_ms": metric.timestamp_ms,
        }
        for metric in payload.metrics
    ]
    return {
        "entity_id": entity_id,
        "edge_node_id": parsed_topic.edge_node_id,
        "device_id": parsed_topic.device_id,
        "group_id": parsed_topic.group_id,
        "message_type": parsed_topic.message_type,
        "event_type": _event_type(parsed_topic.message_type),
        "event_time": event_time,
        "source_type": source_type,
        "protocol_version": SPARKPLUG_NAMESPACE,
        "seq": payload.seq,
        "data_quality": "good",
        "metrics": metrics,
        "payload_timestamp_ms": payload.timestamp_ms,
    }


class SparkplugSessionState:
    """Tracks Sparkplug birth/death and sequence continuity for an edge node."""

    def __init__(self, group_id: str, edge_node_id: str):
        self.group_id = group_id
        self.edge_node_id = edge_node_id
        self.online = False
        self.primary_host_online = False
        self.births: set[str] = set()
        self.deaths: set[str] = set()
        self.last_seq: int | None = None
        self.out_of_order = False
        self.duplicate = False
        self.gaps = 0

    def record(
        self,
        message_type: str,
        seq: int | None,
        device_id: str | None = None,
    ) -> dict[str, Any]:
        if message_type == "STATE":
            self.primary_host_online = self.edge_node_id == "online"
            return self.snapshot()
        key = device_id or self.edge_node_id
        if message_type in ("NBIRTH", "DBIRTH"):
            self.births.add(key)
            self.online = True
        if message_type in ("NDEATH", "DDEATH"):
            self.deaths.add(key)
            if not device_id:
                self.online = False
        if seq is not None:
            if self.last_seq is not None:
                expected = (self.last_seq + 1) % 256
                if seq == self.last_seq:
                    self.duplicate = True
                elif seq != expected:
                    self.out_of_order = True
                    self.gaps += (seq - expected) % 256
            self.last_seq = seq
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        return {
            "group_id": self.group_id,
            "edge_node_id": self.edge_node_id,
            "online": self.online,
            "primary_host_online": self.primary_host_online,
            "births": sorted(self.births),
            "deaths": sorted(self.deaths),
            "last_seq": self.last_seq,
            "out_of_order": self.out_of_order,
            "duplicate": self.duplicate,
            "gaps": self.gaps,
        }


class SparkplugAdapter(BaseAdapter):
    """Edge adapter that converts Sparkplug B topic/payload pairs to EWOH frames."""

    DEVICE_TYPE = "sparkplug_edge_node"

    def __init__(
        self,
        device_id: str,
        group_id: str,
        source_type: str = "real",
        model: str = "SPARKPLUG-B",
    ):
        super().__init__(
            device_id,
            source_type=source_type,
            model=model,
            firmware_version=SPARKPLUG_NAMESPACE,
        )
        self.group_id = group_id
        self.session = SparkplugSessionState(group_id, device_id)
        self._inbox: queue.Queue = queue.Queue(maxsize=1024)
        self._last_msg: dict[str, Any] | None = None
        self._last_seen: str | None = None
        self._lock = threading.Lock()

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
            "session": self.session.snapshot(),
        }

    def device_info(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "group_id": self.group_id,
            "protocol_version": SPARKPLUG_NAMESPACE,
        }

    def read_message(self, timeout=None) -> dict[str, Any] | None:
        try:
            msg = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        self._last_msg = msg
        self._last_seen = msg.get("event_time")
        return msg

    def _enqueue_raw(self, topic: str, payload_bytes: bytes) -> None:
        """Parse and enqueue one Sparkplug B message (real driver callback)."""
        msg = normalize_sparkplug_message(topic, payload_bytes, self.source_type)
        session = self.session.record(
            msg["message_type"],
            msg["seq"],
            msg.get("device_id"),
        )
        msg["session_state"] = session
        if session.get("out_of_order") or session.get("duplicate"):
            msg["data_quality"] = "degraded"
        try:
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass
