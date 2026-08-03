"""Connector SDK/runtime contract tests (Final 5.0 Y1-03)."""

import struct
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.connectors.runtime import (  # noqa: E402
    Connector,
    ConnectorManifest,
    ConnectorManifestError,
    discover_manifests,
    healthcheck,
    load_manifest,
    redact_config,
    validate_config,
)
from edge_platform.connectors.sparkplug import (  # noqa: E402
    SparkplugAdapter,
    SparkplugSessionState,
    SparkplugTopicError,
    decode_sparkplug_payload,
    normalize_sparkplug_message,
    parse_sparkplug_topic,
)

MANIFEST_DIR = SRC / "edge_platform" / "connectors" / "manifests"


class TestManifestContract(unittest.TestCase):
    def test_discover_returns_both_sample_manifests(self):
        manifests = discover_manifests(MANIFEST_DIR)
        self.assertEqual(
            {manifest.id for manifest in manifests},
            {
                "exoskeleton-frame",
                "equipment-state",
                "erp-mes-profile",
                "sparkplug-b",
            },
        )

    def test_exoskeleton_manifest_has_productization_fields(self):
        manifest = load_manifest(MANIFEST_DIR / "exoskeleton-frame-1.0.0.json")
        self.assertEqual(manifest.version, "1.0.0")
        self.assertEqual(manifest.runtime, "edge-python")
        self.assertEqual(manifest.protocol, "exo-jsonl")
        self.assertIn("TelemetryObserved", manifest.output_events)
        self.assertEqual(manifest.compatibility["core"], ">=0.6.0-rc2 <1.0.0")
        self.assertEqual(manifest.rollback, "supported")
        self.assertTrue(manifest.sbom)
        self.assertTrue(manifest.tck)

    def test_missing_required_field_is_rejected(self):
        raw = {
            "id": "broken",
            "version": "1.0.0",
            "runtime": "edge-python",
            "protocol": "exo-jsonl",
            "outputEvents": ["TelemetryObserved"],
            "configSchema": {},
            "compatibility": {},
            "permissions": {},
            "tck": "tck.yaml",
            "sbom": "sbom.json",
        }
        with self.assertRaises(ConnectorManifestError):
            ConnectorManifest.from_dict(raw)

    def test_non_semver_version_is_rejected(self):
        raw = {
            "id": "broken",
            "version": "latest",
            "runtime": "edge-python",
            "protocol": "exo-jsonl",
            "outputEvents": ["TelemetryObserved"],
            "configSchema": {},
            "compatibility": {},
            "permissions": {},
            "tck": "tck.yaml",
            "sbom": "sbom.json",
            "rollback": "supported",
        }
        with self.assertRaises(ConnectorManifestError):
            ConnectorManifest.from_dict(raw)


class TestConfigAndHealth(unittest.TestCase):
    def setUp(self):
        self.exo = load_manifest(MANIFEST_DIR / "exoskeleton-frame-1.0.0.json")
        self.mqtt = load_manifest(MANIFEST_DIR / "equipment-state-1.0.0.json")

    def test_valid_exo_config_health_ok(self):
        report = healthcheck(
            self.exo,
            {
                "deviceId": "EXO-001",
                "workerId": "P-001",
                "sourceType": "simulated",
            },
        )
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["reasons"], [])

    def test_missing_required_config_is_rejected(self):
        with self.assertRaises(ConnectorManifestError):
            validate_config(self.exo, {"deviceId": "EXO-001"})

    def test_mqtt_without_broker_is_degraded(self):
        report = healthcheck(
            self.mqtt,
            {"topicPrefix": "factory/1", "clientId": "edge-1"},
        )
        self.assertEqual(report["status"], "degraded")
        self.assertTrue(any("brokerUrl" in reason for reason in report["reasons"]))

    def test_erp_mes_profile_requires_secret_reference_not_value(self):
        manifest = load_manifest(MANIFEST_DIR / "erp-mes-profile-1.0.0.json")
        report = healthcheck(
            manifest,
            {
                "baseUrl": "https://erp.example.com",
                "clientId": "mes-edge",
                "secretName": "erp-credentials",
            },
        )
        self.assertEqual(report["status"], "ok")
        self.assertIn("OrderAcknowledged", report["outputEvents"])
        with self.assertRaises(ConnectorManifestError):
            validate_config(manifest, {"baseUrl": "https://erp.example.com"})

    def test_redact_config_hides_secrets_recursively(self):
        config = {
            "brokerUrl": "mqtt://localhost",
            "clientId": "edge-1",
            "auth": {"password": "secret", "apiKey": "abc", "safe": 1},
        }
        redacted = redact_config(config)
        self.assertEqual(redacted["auth"]["password"], "[REDACTED]")
        self.assertEqual(redacted["auth"]["apiKey"], "[REDACTED]")
        self.assertEqual(redacted["auth"]["safe"], 1)
        self.assertEqual(config["auth"]["password"], "secret")


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


def _metric_bytes(name, datatype, value, value_field):
    if value_field == 11:
        encoded = _field(11, 5, struct.pack("<f", float(value)))
    elif value_field == 12:
        encoded = _field(12, 1, struct.pack("<d", float(value)))
    elif value_field == 13:
        encoded = _field(13, 0, _varint(1 if value else 0))
    else:
        encoded = _field(value_field, 0, _varint(value))
    parts = [
        _string_field(1, name),
        _field(4, 0, _varint(datatype)),
        encoded,
    ]
    body = b"".join(parts)
    return _field(5, 2, _varint(len(body)) + body)


def _sparkplug_payload(seq, metrics):
    parts = [
        _field(1, 0, _varint(1_756_000_000_000)),
        _field(2, 0, _varint(seq)),
        _string_field(3, "test-uuid"),
    ]
    parts.extend(metrics)
    return b"".join(parts)


class TestSparkplugB(unittest.TestCase):
    def test_topic_parser_handles_edge_and_device_topics(self):
        edge = parse_sparkplug_topic("spBv1.0/factory-a/NBIRTH/edge-1")
        self.assertEqual(edge.group_id, "factory-a")
        self.assertEqual(edge.message_type, "NBIRTH")
        self.assertEqual(edge.edge_node_id, "edge-1")
        self.assertIsNone(edge.device_id)

        device = parse_sparkplug_topic("spBv1.0/factory-a/DDATA/edge-1/cnc-01")
        self.assertEqual(device.message_type, "DDATA")
        self.assertEqual(device.device_id, "cnc-01")

        state = parse_sparkplug_topic("spBv1.0/STATE/online")
        self.assertEqual(state.message_type, "STATE")
        self.assertEqual(state.edge_node_id, "online")

    def test_invalid_topic_is_rejected(self):
        with self.assertRaises(SparkplugTopicError):
            parse_sparkplug_topic("factory-a/NBIRTH/edge-1")
        with self.assertRaises(SparkplugTopicError):
            parse_sparkplug_topic("spBv1.0/factory-a/BIRTH/edge-1")

    def test_payload_decoder_reads_metrics_and_sequence(self):
        payload = _sparkplug_payload(
            7,
            [
                _metric_bytes("load_percent", 8, 850, 11),
                _metric_bytes("running", 10, 1, 13),
            ],
        )
        decoded = decode_sparkplug_payload(payload)
        self.assertEqual(decoded.seq, 7)
        self.assertEqual(decoded.timestamp_ms, 1_756_000_000_000)
        self.assertEqual(decoded.uuid, "test-uuid")
        self.assertEqual(len(decoded.metrics), 2)
        self.assertEqual(decoded.metrics[0].name, "load_percent")
        self.assertEqual(decoded.metrics[0].datatype_name, "Float")
        self.assertEqual(decoded.metrics[0].value, 850)
        self.assertEqual(decoded.metrics[1].value, True)

    def test_payload_decoder_reads_string_metric(self):
        metric_body = _string_field(1, "mode") + _string_field(14, "auto")
        payload = _sparkplug_payload(8, [_field(5, 2, _varint(len(metric_body)) + metric_body)])
        decoded = decode_sparkplug_payload(payload)
        self.assertEqual(decoded.metrics[0].name, "mode")
        self.assertEqual(decoded.metrics[0].value, "auto")

    def test_normalize_emits_canonical_telemetry_envelope(self):
        payload = _sparkplug_payload(1, [_metric_bytes("temp_c", 9, 230, 12)])
        message = normalize_sparkplug_message(
            "spBv1.0/factory-a/DDATA/edge-1/cnc-01",
            payload,
            source_type="real",
        )
        self.assertEqual(message["entity_id"], "cnc-01")
        self.assertEqual(message["edge_node_id"], "edge-1")
        self.assertEqual(message["message_type"], "DDATA")
        self.assertEqual(message["event_type"], "TelemetryObserved")
        self.assertEqual(message["source_type"], "real")
        self.assertEqual(message["protocol_version"], "spBv1.0")
        self.assertEqual(message["metrics"][0]["name"], "temp_c")
        self.assertEqual(message["metrics"][0]["value"], 230)

    def test_session_state_tracks_birth_death_and_sequence_gaps(self):
        session = SparkplugSessionState("factory-a", "edge-1")
        session.record("NBIRTH", 1)
        session.record("DDATA", 2, "cnc-01")
        session.record("DDATA", 4, "cnc-01")
        snapshot = session.snapshot()
        self.assertTrue(snapshot["online"])
        self.assertIn("edge-1", snapshot["births"])
        self.assertTrue(snapshot["out_of_order"])
        self.assertEqual(snapshot["gaps"], 1)

        duplicate = SparkplugSessionState("factory-a", "edge-2")
        duplicate.record("NBIRTH", 5)
        duplicate.record("NDATA", 5)
        self.assertTrue(duplicate.snapshot()["duplicate"])

    def test_adapter_enqueues_normalized_messages(self):
        adapter = SparkplugAdapter("edge-1", "factory-a", source_type="simulated")
        adapter.start()
        adapter._enqueue_raw(
            "spBv1.0/factory-a/NBIRTH/edge-1",
            _sparkplug_payload(1, []),
        )
        adapter._enqueue_raw(
            "spBv1.0/factory-a/NDATA/edge-1",
            _sparkplug_payload(2, [_metric_bytes("rpm", 6, 1200, 9)]),
        )
        message = adapter.read_message(timeout=0.1)
        self.assertIsNotNone(message)
        self.assertEqual(message["entity_id"], "edge-1")
        self.assertEqual(message["source_type"], "simulated")
        self.assertEqual(message["session_state"]["online"], True)
        adapter.stop()


class TestConnectorLifecycle(unittest.TestCase):
    def test_start_stop_and_health(self):
        manifest = load_manifest(MANIFEST_DIR / "exoskeleton-frame-1.0.0.json")
        connector = Connector(
            manifest,
            {
                "deviceId": "EXO-001",
                "workerId": "P-001",
                "sourceType": "simulated",
            },
        )
        self.assertFalse(connector.is_running)
        connector.start()
        self.assertTrue(connector.is_running)
        report = connector.health()
        self.assertEqual(report["status"], "ok")
        self.assertTrue(report["running"])
        connector.stop()
        self.assertFalse(connector.is_running)

    def test_redacted_config_keeps_connector_usable(self):
        manifest = load_manifest(MANIFEST_DIR / "equipment-state-1.0.0.json")
        connector = Connector(
            manifest,
            {
                "brokerUrl": "mqtt://localhost",
                "topicPrefix": "factory/1",
                "clientId": "edge-1",
                "password": "do-not-leak",
            },
        )
        redacted = connector.redacted_config()
        self.assertEqual(redacted["password"], "[REDACTED]")
        self.assertEqual(connector.config["password"], "do-not-leak")


if __name__ == "__main__":
    unittest.main()
