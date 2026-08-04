---
workItemIds: [T-261, T-262, T-263, T-264, T-265, T-266, T-267, T-268, T-269, T-270]
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 27 Evidence - Connector SDK/Runtime

Date: 2026-08-03
Scope: Final 5.0 Y1-03/Y2-02 connector SDK and runtime.

## Implemented

- Added `src/edge_platform/connectors/runtime.py` with manifest loading and
  validation, config validation, health checks, secret redaction, and
  connector lifecycle state.
- Added versioned sample manifests:
  `exoskeleton-frame-1.0.0.json` (exo-jsonl) and
  `equipment-state-1.0.0.json` (mqtt), each carrying output events, config
  schema, compatibility, permissions, TCK, SBOM, and rollback fields.
- Added `tests/test_connector_runtime.py` covering manifest contract,
  config/health behavior, redaction, and lifecycle.
- Runtime remains pure Python standard library; real protocol drivers stay in
  edge adapters behind the same manifest contract.

## Verification

```text
python3 -m pytest tests/ -q: 69 passed
python3 -m ruff check src tests: All checks passed
Connector runtime tests: 10 passed
```
