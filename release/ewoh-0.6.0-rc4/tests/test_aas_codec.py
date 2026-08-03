"""AAS/IEC 63278 codec contract tests (Final 5.0 AA-07)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.aas.codec import (  # noqa: E402
    AasCodecError,
    aas_to_twin_semantics,
    pack_aasx,
    parse_aas_json,
    redact_aas,
    to_aas_json,
    twin_to_aas,
    unpack_aasx,
)

SAMPLE = SRC / "edge_platform" / "aas" / "examples" / "discrete-machining-aas.json"


class TestAasJsonCodec(unittest.TestCase):
    def test_parses_canonical_aas_json_sample(self):
        shell = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
        self.assertEqual(
            shell.asset_id,
            "urn:ewoh:factory-a:discrete-machining-line:001",
        )
        self.assertEqual(len(shell.submodels), 2)
        self.assertEqual(shell.submodels[0].id_short, "operations")
        self.assertEqual(shell.submodels[0].properties[0].value, 0.85)
        self.assertEqual(shell.submodels[1].properties[1].semantic_id, "ewoh:maintenance:calibration")

    def test_json_roundtrip_preserves_values_and_types(self):
        original = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
        rebuilt = parse_aas_json(to_aas_json(original))
        self.assertEqual(to_aas_json(original), to_aas_json(rebuilt))
        self.assertEqual(original.submodels[0].properties[0].value_type, "number")

    def test_rejects_missing_asset_id(self):
        with self.assertRaises(AasCodecError):
            parse_aas_json({"idShort": "broken", "submodels": []})

    def test_rejects_unknown_value_type(self):
        with self.assertRaises(AasCodecError):
            parse_aas_json(
                {
                    "assetId": "urn:test:asset",
                    "idShort": "asset",
                    "submodels": [
                        {
                            "id": "urn:test:submodel",
                            "idShort": "sm",
                            "elements": [
                                {
                                    "idShort": "p",
                                    "value": 1,
                                    "valueType": "made-up",
                                }
                            ],
                        }
                    ],
                }
            )


class TestAasTwinMapping(unittest.TestCase):
    def test_aas_to_twin_semantics(self):
        shell = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
        mapping = aas_to_twin_semantics(shell)
        self.assertEqual(mapping["assetId"], shell.asset_id)
        self.assertEqual(mapping["semantics"], ["operations", "maintenance"])
        self.assertEqual(mapping["submodels"][0]["properties"][0]["name"], "oeeAvailabilityTarget")

    def test_twin_to_aas(self):
        shell = twin_to_aas(
            "urn:test:line",
            "测试产线",
            [
                {
                    "id": "urn:test:sm",
                    "idShort": "operations",
                    "elements": [
                        {
                            "idShort": "shiftCount",
                            "value": 2,
                            "valueType": "integer",
                        }
                    ],
                }
            ],
        )
        self.assertEqual(shell.submodels[0].properties[0].value, 2)


class TestAasxPackage(unittest.TestCase):
    def test_pack_unpack_roundtrip(self):
        shell = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "line.aasx"
            pack_aasx(shell, package)
            self.assertTrue(package.is_file())
            rebuilt = unpack_aasx(package)
        self.assertEqual(to_aas_json(rebuilt), to_aas_json(shell))

    def test_pack_rejects_existing_file(self):
        shell = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "existing.aasx"
            package.write_text("occupied", encoding="utf-8")
            with self.assertRaises(AasCodecError):
                pack_aasx(shell, package)

    def test_unpack_rejects_missing_aas_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "broken.aasx"
            import zipfile

            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("aasx/origin", "no aas.json")
            with self.assertRaises(AasCodecError):
                unpack_aasx(package)


class TestAasRedaction(unittest.TestCase):
    def test_redact_hides_credential_values(self):
        document = {
            "assetId": "urn:test",
            "submodels": [
                {
                    "elements": [
                        {"idShort": "safe", "value": 1},
                        {"idShort": "password", "value": "do-not-leak"},
                    ]
                }
            ],
        }
        redacted = redact_aas(document)
        self.assertEqual(redacted["submodels"][0]["elements"][1]["value"], "[REDACTED]")
        self.assertEqual(document["submodels"][0]["elements"][1]["value"], "do-not-leak")


if __name__ == "__main__":
    unittest.main()
