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
