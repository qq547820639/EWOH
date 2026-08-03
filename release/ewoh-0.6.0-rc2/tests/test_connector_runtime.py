"""Connector SDK/runtime contract tests (Final 5.0 Y1-03)."""

import hashlib
import hmac
import struct
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.connectors.csvfile import (  # noqa: E402
    CsvFileAdapter,
    CsvFileError,
    CsvMapping,
    parse_csv_rows,
)
from edge_platform.connectors.modbus import (  # noqa: E402
    ModbusAdapter,
    ModbusError,
    normalize_modbus_datapoint,
    parse_modbus_register,
)
from edge_platform.connectors.opcua import (  # noqa: E402
    OpcUaAdapter,
    normalize_opcua_datapoint,
    parse_opcua_node_id,
)
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
from edge_platform.connectors.webhook import (  # noqa: E402
    WebhookAdapter,
    normalize_webhook_payload,
    verify_webhook_signature,
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
                "opcua-generic",
                "modbus-tcp-generic",
                "http-webhook-generic",
                "csv-file-generic",
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


class TestOpcUa(unittest.TestCase):
    def test_node_id_parser_supports_numeric_and_string(self):
        numeric = parse_opcua_node_id("ns=2;i=85")
        self.assertEqual(numeric.namespace, 2)
        self.assertEqual(numeric.identifier, "85")
        string_node = parse_opcua_node_id("ns=3;s=Temperature")
        self.assertEqual(string_node.identifier_type, "s")
        self.assertEqual(string_node.identifier, "Temperature")

    def test_normalize_maps_quality_and_entity(self):
        point = normalize_opcua_datapoint(
            {
                "nodeId": "ns=2;i=85",
                "value": 42.5,
                "qualityCode": "Good",
                "unit": "°C",
            },
            default_entity_id="CNC-01",
            default_source_type="real",
        )
        self.assertEqual(point["entity_id"], "CNC-01")
        self.assertEqual(point["quality_status"], "good")
        self.assertEqual(point["value"], 42.5)

    def test_bad_quality_is_degraded(self):
        point = normalize_opcua_datapoint(
            {
                "nodeId": "ns=1;s=Pressure",
                "value": 0,
                "qualityCode": "BadNoCommunication",
            }
        )
        self.assertEqual(point["quality_status"], "degraded")

    def test_adapter_enqueues_normalized_point(self):
        adapter = OpcUaAdapter(
            "opc-connector-1",
            "opc.tcp://factory-lan:4840",
            source_type="simulated",
        )
        adapter.start()
        adapter._enqueue_raw(
            {
                "nodeId": "ns=2;i=85",
                "value": 100,
                "qualityCode": "Good",
                "sourceTimestamp": "2026-08-03T00:00:00Z",
            }
        )
        message = adapter.read_message(timeout=0.1)
        self.assertIsNotNone(message)
        self.assertEqual(message["entity_id"], "85")
        self.assertEqual(message["source_type"], "simulated")
        adapter.stop()


class TestModbus(unittest.TestCase):
    def test_register_parser_validates_address_and_function(self):
        register = parse_modbus_register(40001, 3, 0.1)
        self.assertEqual(register.address, 40001)
        self.assertEqual(register.function_code, 3)
        self.assertEqual(register.scale, 0.1)
        with self.assertRaises(ModbusError):
            parse_modbus_register(-1, 3)
        with self.assertRaises(ModbusError):
            parse_modbus_register(0, 99)

    def test_normalize_applies_scaling(self):
        point = normalize_modbus_datapoint(
            {
                "registerAddress": 40001,
                "functionCode": 3,
                "value": 1234,
                "scale": 0.1,
                "unit": "mm",
            },
            default_entity_id="CNC-01",
            default_source_type="real",
        )
        self.assertEqual(point["entity_id"], "CNC-01")
        self.assertEqual(point["scaled_value"], 123.4)
        self.assertEqual(point["protocol_version"], "Modbus-TCP")

    def test_adapter_enqueues_normalized_point(self):
        adapter = ModbusAdapter(
            "modbus-1",
            "factory-lan",
            port=502,
            unit_id=1,
            source_type="simulated",
        )
        adapter.start()
        adapter._enqueue_raw(
            {
                "registerAddress": 0,
                "functionCode": 3,
                "value": 42,
                "sourceTimestamp": "2026-08-03T00:00:00Z",
            }
        )
        message = adapter.read_message(timeout=0.1)
        self.assertIsNotNone(message)
        self.assertEqual(message["entity_id"], "modbus:0")
        self.assertEqual(message["source_type"], "simulated")
        adapter.stop()


class TestWebhook(unittest.TestCase):
    def test_signature_verification_is_constant_time(self):
        payload = b'{"deviceId":"CNC-01"}'
        signature = hmac.new(b"secret", payload, hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook_signature(payload, signature, "secret"))
        self.assertFalse(verify_webhook_signature(payload, signature, "wrong"))

    def test_normalize_payload(self):
        point = normalize_webhook_payload(
            {"deviceId": "CNC-01", "eventType": "TelemetryObserved"},
            default_source_type="real",
        )
        self.assertEqual(point["entity_id"], "CNC-01")
        self.assertEqual(point["protocol_version"], "HTTP-Webhook")

    def test_adapter_enqueues_payload(self):
        adapter = WebhookAdapter(
            "webhook-1",
            endpoint_path="/webhook/ewoh",
            source_type="simulated",
        )
        adapter.start()
        adapter._enqueue_raw(
            {"deviceId": "CNC-01", "eventType": "DeviceStateChanged"}
        )
        message = adapter.read_message(timeout=0.1)
        self.assertIsNotNone(message)
        self.assertEqual(message["entity_id"], "CNC-01")
        self.assertEqual(message["source_type"], "simulated")
        adapter.stop()


class TestCsvFile(unittest.TestCase):
    def test_parse_rows_with_mapping(self):
        rows = parse_csv_rows(
            "device_id,value,unit\nCNC-01,12.5,mm\nCNC-02,20,mm\n",
            CsvMapping(entity_id="device_id", value="value", unit="unit"),
            default_source_type="real",
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["value"], 12.5)
        self.assertEqual(rows[0]["unit"], "mm")
        self.assertEqual(rows[1]["entity_id"], "CNC-02")

    def test_empty_csv_is_rejected(self):
        with self.assertRaises(CsvFileError):
            parse_csv_rows(
                "device_id,value\n",
                CsvMapping(entity_id="device_id", value="value"),
            )

    def test_adapter_enqueues_rows(self):
        adapter = CsvFileAdapter(
            "csv-1",
            CsvMapping(entity_id="device_id", value="value"),
            source_type="simulated",
        )
        adapter.start()
        adapter._enqueue_csv("device_id,value\nCNC-01,1\nCNC-02,2\n")
        first = adapter.read_message(timeout=0.1)
        second = adapter.read_message(timeout=0.1)
        self.assertEqual(first["entity_id"], "CNC-01")
        self.assertEqual(second["entity_id"], "CNC-02")
        self.assertEqual(first["source_type"], "simulated")
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
