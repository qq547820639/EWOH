"""Connector SDK/runtime contract tests (Final 5.0 Y1-03)."""

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

MANIFEST_DIR = SRC / "edge_platform" / "connectors" / "manifests"


class TestManifestContract(unittest.TestCase):
    def test_discover_returns_both_sample_manifests(self):
        manifests = discover_manifests(MANIFEST_DIR)
        self.assertEqual(
            {manifest.id for manifest in manifests},
            {"exoskeleton-frame", "equipment-state"},
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
