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
