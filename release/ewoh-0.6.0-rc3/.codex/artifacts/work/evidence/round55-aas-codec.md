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
