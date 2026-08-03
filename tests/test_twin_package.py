"""Twin package pipeline contract tests (Final 5.0 Y2-09)."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.twin.package import (  # noqa: E402
    TwinPackageManifest,
    TwinPackageManifestError,
    discover_manifests,
    healthcheck,
    load_manifest,
    redact_calibration,
    validate_calibration,
)

MANIFEST_DIR = SRC / "edge_platform" / "twin" / "manifests"


class TestTwinManifestContract(unittest.TestCase):
    def test_discover_returns_both_sample_manifests(self):
        manifests = discover_manifests(MANIFEST_DIR)
        self.assertEqual(
            {manifest.id for manifest in manifests},
            {"discrete-machining-line", "assembly-cell"},
        )

    def test_machining_manifest_has_productization_fields(self):
        manifest = load_manifest(MANIFEST_DIR / "discrete-machining-line-1.0.0.json")
        self.assertEqual(manifest.version, "1.0.0")
        self.assertEqual(manifest.model_format, "gltf")
        self.assertEqual(manifest.coordinate_system, "rh-y-up")
        self.assertIn("worker", manifest.semantics)
        self.assertEqual(manifest.rollback, "supported")

    def test_missing_required_field_is_rejected(self):
        raw = {
            "id": "broken",
            "version": "1.0.0",
            "modelFormat": "gltf",
            "coordinateSystem": "rh-y-up",
            "unit": "mm",
            "calibration": {},
            "semantics": ["station"],
            "compatibility": {},
            "tck": "tck.yaml",
            "sbom": "sbom.json",
        }
        with self.assertRaises(TwinPackageManifestError):
            TwinPackageManifest.from_dict(raw)

    def test_bad_version_is_rejected(self):
        raw = {
            "id": "broken",
            "version": "latest",
            "modelFormat": "gltf",
            "coordinateSystem": "rh-y-up",
            "unit": "mm",
            "calibration": {},
            "semantics": ["station"],
            "compatibility": {},
            "tck": "tck.yaml",
            "sbom": "sbom.json",
            "rollback": "supported",
        }
        with self.assertRaises(TwinPackageManifestError):
            TwinPackageManifest.from_dict(raw)


class TestCalibrationAndHealth(unittest.TestCase):
    def setUp(self):
        self.machining = load_manifest(
            MANIFEST_DIR / "discrete-machining-line-1.0.0.json"
        )
        self.cell = load_manifest(MANIFEST_DIR / "assembly-cell-1.0.0.json")

    def test_calibrated_manifest_health_ok(self):
        report = healthcheck(
            self.cell,
            {"cameraToWorld": {"matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}},
        )
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["reasons"], [])

    def test_missing_calibration_is_degraded(self):
        with self.assertRaises(TwinPackageManifestError):
            validate_calibration(self.machining, {"cameraToWorld": {}})
        report = healthcheck(self.machining, {})
        self.assertEqual(report["status"], "degraded")
        self.assertTrue(any("cameraToWorld" in r for r in report["reasons"]))

    def test_redact_calibration_hides_secrets(self):
        calibration = {
            "cameraToWorld": {"matrix": [1]},
            "auth": {"password": "secret", "safe": 1},
        }
        redacted = redact_calibration(calibration)
        self.assertEqual(redacted["auth"]["password"], "[REDACTED]")
        self.assertEqual(redacted["auth"]["safe"], 1)
        self.assertEqual(calibration["auth"]["password"], "secret")


if __name__ == "__main__":
    unittest.main()
