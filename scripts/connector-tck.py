#!/usr/bin/env python3
"""Connector TCK (Final 5.0 Y3-01).

Runs manifest, config, health, redaction, and out-of-order/backfill checks
against the connector runtime and edge sequence buffer.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.connectors.opcua import (  # noqa: E402
    normalize_opcua_datapoint,
    parse_opcua_node_id,
)
from edge_platform.connectors.runtime import (  # noqa: E402
    ConnectorManifestError,
    discover_manifests,
    healthcheck,
    redact_config,
    validate_config,
)
from edge_platform.connectors.sparkplug import (  # noqa: E402
    SparkplugSessionState,
    decode_sparkplug_payload,
    normalize_sparkplug_message,
    parse_sparkplug_topic,
)
from edge_platform.edge.backfill import SequenceBuffer  # noqa: E402

MANIFEST_DIR = SRC / "edge_platform" / "connectors" / "manifests"

CONFIGS = {
    "exoskeleton-frame": {
        "deviceId": "EXO-001",
        "workerId": "P-001",
        "sourceType": "simulated",
    },
    "equipment-state": {
        "brokerUrl": "mqtt://factory-lan",
        "topicPrefix": "factory/1",
        "clientId": "edge-1",
    },
    "erp-mes-profile": {
        "baseUrl": "https://erp.example.com",
        "clientId": "mes-edge",
        "secretName": "erp-credentials",
    },
    "sparkplug-b": {
        "brokerUrl": "mqtt://factory-lan",
        "groupId": "factory-a",
        "clientId": "edge-1",
    },
    "opcua-generic": {
        "endpointUrl": "opc.tcp://factory-lan:4840",
        "nodeIds": ["ns=2;i=85"],
    },
}

checks: list[tuple[str, bool]] = []


def check(name: str, condition: bool) -> None:
    checks.append((name, bool(condition)))


manifests = discover_manifests(MANIFEST_DIR)
check("discover manifests >= 5", len(manifests) >= 5)

for manifest in manifests:
    config = CONFIGS[manifest.id]
    try:
        validate_config(manifest, config)
        config_ok = True
    except ConnectorManifestError:
        config_ok = False
    check(f"config {manifest.id}", config_ok)
    report = healthcheck(manifest, config)
    check(f"health {manifest.id}", report["status"] == "ok")

redacted = redact_config({"auth": {"password": "secret", "safe": 1}})
check(
    "redaction",
    redacted["auth"]["password"] == "[REDACTED]" and redacted["auth"]["safe"] == 1,
)

buffer = SequenceBuffer()
for seq in (2, 1, 3):
    buffer.push({"seq": seq})
check("sequence order", [f["seq"] for f in buffer.ready()] == [1, 2, 3])

gap = SequenceBuffer()
gap.push({"seq": 1})
gap.push({"seq": 3})
gap.ready()
check("gap detection", gap.missing() == [2])
gap.push({"seq": 2})
check("backfill", [f["seq"] for f in gap.ready()] == [2, 3])


def _varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            break
    return bytes(out)


def _field(field_no, wire_type, value):
    return _varint((field_no << 3) | wire_type) + value


def _string_field(field_no, text):
    raw = text.encode("utf-8")
    return _field(field_no, 2, _varint(len(raw)) + raw)


def _numeric_metric_field(value_field, value):
    if value_field == 12:
        return _field(12, 1, struct.pack("<d", float(value)))
    return _field(value_field, 0, _varint(value))


def _sparkplug_payload(seq, metric_name, datatype, value_field, value):
    metric_body = _string_field(1, metric_name) + _field(
        4, 0, _varint(datatype)
    ) + _numeric_metric_field(value_field, value)
    return (
        _field(1, 0, _varint(1_756_000_000_000))
        + _field(2, 0, _varint(seq))
        + _field(5, 2, _varint(len(metric_body)) + metric_body)
    )


topic = parse_sparkplug_topic("spBv1.0/factory-a/DDATA/edge-1/cnc-01")
check(
    "sparkplug topic",
    topic.group_id == "factory-a"
    and topic.message_type == "DDATA"
    and topic.device_id == "cnc-01",
)
payload = _sparkplug_payload(3, "temp_c", 9, 12, 230)
decoded = decode_sparkplug_payload(payload)
check(
    "sparkplug codec",
    decoded.seq == 3
    and decoded.metrics[0].name == "temp_c"
    and decoded.metrics[0].value == 230,
)
message = normalize_sparkplug_message(
    "spBv1.0/factory-a/DDATA/edge-1/cnc-01",
    payload,
    source_type="real",
)
check(
    "sparkplug canonical envelope",
    message["entity_id"] == "cnc-01"
    and message["protocol_version"] == "spBv1.0"
    and message["event_type"] == "TelemetryObserved",
)
session = SparkplugSessionState("factory-a", "edge-1")
session.record("NBIRTH", 1)
session.record("NDATA", 1)
check(
    "sparkplug session state",
    session.snapshot()["online"]
    and session.snapshot()["duplicate"]
    and session.snapshot()["births"] == ["edge-1"],
)

opcua_node = parse_opcua_node_id("ns=2;i=85")
check(
    "opcua node id",
    opcua_node.namespace == 2
    and opcua_node.identifier_type == "i"
    and opcua_node.identifier == "85",
)
opcua_point = normalize_opcua_datapoint(
    {
        "nodeId": "ns=2;i=85",
        "value": 42.5,
        "qualityCode": "Good",
        "sourceTimestamp": "2026-08-03T00:00:00Z",
    },
    default_source_type="real",
)
check(
    "opcua canonical point",
    opcua_point["entity_id"] == "85"
    and opcua_point["quality_status"] == "good"
    and opcua_point["value"] == 42.5,
)

failed = [name for name, ok in checks if not ok]
if failed:
    print(f"CONNECTOR TCK FAILED: {', '.join(failed)}")
    sys.exit(1)

print(f"CONNECTOR TCK PASSED ({len(checks)} checks)")
