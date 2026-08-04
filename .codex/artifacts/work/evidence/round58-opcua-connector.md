# Round 58 Evidence - OPC UA Connector

Date: 2026-08-03
Scope: Final 5.0 AA-05: OPC UA node ID parsing, data point normalization,
quality mapping, edge adapter, and connector manifest.

## Implemented

- `src/edge_platform/connectors/opcua.py`: OPC UA node ID parser
  (`ns=<n>;i|s|g|b=<id>`), canonical telemetry envelope, quality code mapping
  (`Good` -> good, `Bad*` -> degraded), and `BaseAdapter`-compatible edge
  adapter.
- `opcua-generic-1.0.0.json` connector manifest with endpoint/nodeIds config,
  output events, compatibility, and network permission.
- Connector TCK extended from 17 to 21 checks for OPC UA node ID and canonical
  data point mapping.

## Verification

```text
Python contract tests: 111 passed (was 107)
Connector TCK: 21/21 checks passed
ruff: clean
```

The OPC UA tests cover numeric/string node IDs, Good/Bad quality mapping,
canonical envelope normalization, and adapter enqueue/read.
