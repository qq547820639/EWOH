#!/usr/bin/env python3
"""Connector TCK (Final 5.0 Y3-01).

Runs manifest, config, health, redaction, and out-of-order/backfill checks
against the connector runtime and edge sequence buffer.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.connectors.runtime import (  # noqa: E402
    ConnectorManifestError,
    discover_manifests,
    healthcheck,
    redact_config,
    validate_config,
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
}

checks: list[tuple[str, bool]] = []


def check(name: str, condition: bool) -> None:
    checks.append((name, bool(condition)))


manifests = discover_manifests(MANIFEST_DIR)
check("discover manifests >= 3", len(manifests) >= 3)

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

failed = [name for name, ok in checks if not ok]
if failed:
    print(f"CONNECTOR TCK FAILED: {', '.join(failed)}")
    sys.exit(1)

print(f"CONNECTOR TCK PASSED ({len(checks)} checks)")
