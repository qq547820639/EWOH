---
workItemIds: [T-581, T-582, T-583, T-584, T-585, T-586, T-587, T-588, T-589, T-590]
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

# Round 59 Evidence - Modbus TCP Connector

Date: 2026-08-03
Scope: Final 5.0 AA-05: Modbus TCP register parsing, scaling, data point
normalization, edge adapter, and connector manifest.

## Implemented

- `src/edge_platform/connectors/modbus.py`: register address/function/scale
  validation, canonical telemetry envelope with scaled value, and
  `BaseAdapter`-compatible edge adapter.
- `modbus-tcp-generic-1.0.0.json` connector manifest with host/port/unitId/
  registers config and Modbus-TCP network permission.
- Connector TCK extended from 21 to 25 checks for Modbus register parsing and
  canonical data point mapping.

## Verification

```text
Python contract tests: 114 passed (was 111)
Connector TCK: 25/25 checks passed
ruff: clean
```

The Modbus tests cover register validation, address/function rejection,
scaled normalization, and adapter enqueue/read.
