#!/usr/bin/env python3
"""AAS/IEC 63278 codec TCK (Final 5.0 AA-07).

Runs JSON parse/export, twin semantic mapping, AASX pack/unpack, and secret
redaction checks against the EWOH AAS codec without external AAS tooling.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.aas.codec import (  # noqa: E402
    aas_to_twin_semantics,
    pack_aasx,
    parse_aas_json,
    redact_aas,
    to_aas_json,
    twin_to_aas,
    unpack_aasx,
)

SAMPLE = SRC / "edge_platform" / "aas" / "examples" / "discrete-machining-aas.json"
checks: list[tuple[str, bool]] = []


def check(name: str, condition: bool) -> None:
    checks.append((name, bool(condition)))


shell = parse_aas_json(json.loads(SAMPLE.read_text(encoding="utf-8")))
check("aas sample parse", shell.asset_id.startswith("urn:ewoh:"))
check("aas submodel count", len(shell.submodels) == 2)

rebuilt = parse_aas_json(to_aas_json(shell))
check("aas json roundtrip", to_aas_json(rebuilt) == to_aas_json(shell))

mapping = aas_to_twin_semantics(shell)
check(
    "aas twin mapping",
    mapping["semantics"] == ["operations", "maintenance"]
    and mapping["submodels"][0]["properties"][0]["name"] == "oeeAvailabilityTarget",
)

generated = twin_to_aas(
    "urn:test:line",
    "测试产线",
    [
        {
            "id": "urn:test:sm",
            "idShort": "operations",
            "elements": [{"idShort": "shiftCount", "value": 2, "valueType": "integer"}],
        }
    ],
)
check("aas twin to aas", generated.submodels[0].properties[0].value == 2)

redacted = redact_aas(
    {
        "submodels": [
            {"elements": [{"idShort": "password", "value": "secret"}]}
        ]
    }
)
check(
    "aas redaction",
    redacted["submodels"][0]["elements"][0]["value"] == "[REDACTED]",
)

with tempfile.TemporaryDirectory() as tmp:
    package = Path(tmp) / "sample.aasx"
    pack_aasx(shell, package)
    unpacked = unpack_aasx(package)
    check("aasx pack/unpack", to_aas_json(unpacked) == to_aas_json(shell))

failed = [name for name, ok in checks if not ok]
if failed:
    print(f"AAS TCK FAILED: {', '.join(failed)}")
    sys.exit(1)

print(f"AAS TCK PASSED ({len(checks)} checks)")
