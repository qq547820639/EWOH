---
workItemIds: T-139
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "make test"
suite: python-edge
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: e09585e3f311195b8de57d3d85a0e17133454a5bb40944a6a5604d0596723ff8
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 55 Evidence - AAS/IEC 63278 Codec

Date: 2026-08-03
Scope: Final 5.0 AA-07: Asset Administration Shell JSON parsing/export,
AASX-like package exchange, and core submodel mapping to EWOH twin semantics.

## Implemented

- `src/edge_platform/aas/codec.py`: dependency-free AAS 3.0 JSON subset codec
  with `AasAssetShell` / `AasSubmodel` / `AasProperty`, value-type validation,
  canonical JSON export, twin semantic mapping, and secret redaction.
- `pack_aasx` / `unpack_aasx`: OPC-like ZIP package with `mimetype`,
  `aasx/aas.json`, origin marker and package manifest.
- `twin_to_aas` / `aas_to_twin_semantics`: bidirectional mapping between AAS
  submodels and EWOH twin semantic properties.
- Sample AAS document for the discrete machining line:
  `src/edge_platform/aas/examples/discrete-machining-aas.json`.
- One-click TCK: `make aas-tck` / `scripts/aas-tck.py` with 7 checks.

## Verification

```text
Python contract tests: 99 passed (was 89)
AAS TCK: 7/7 checks passed
Python unittest: 667 passed
ruff: clean
```

The AAS TCK verifies sample parsing, JSON roundtrip, twin mapping, twin-to-AAS
generation, secret redaction, and AASX pack/unpack roundtrip.
