---
workItemIds: [T-391, T-392, T-393, T-394, T-395, T-396, T-397, T-398, T-399, T-400]
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

# Round 40 Evidence - Connector TCK

Date: 2026-08-03
Scope: Final 5.0 Y3-01 connector TCK.

## Implemented

- Added `scripts/connector-tck.py` which runs 11 checks against connector
  manifests, config validation, health, redaction, and edge sequence
  buffer/backfill behavior.
- Added `make connector-tck` one-command entry point.

## Verification

```text
PYTHONPATH=src python3 scripts/connector-tck.py: CONNECTOR TCK PASSED (11 checks)
python3 -m ruff check scripts/connector-tck.py: All checks passed
```
