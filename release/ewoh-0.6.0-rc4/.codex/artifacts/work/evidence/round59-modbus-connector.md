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
