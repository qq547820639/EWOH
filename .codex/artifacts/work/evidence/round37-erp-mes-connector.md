# Round 37 Evidence - ERP/MES Connector Profile

Date: 2026-08-03
Scope: Final 5.0 Y2-08 ERP/MES generic connector profile.

## Implemented

- Added `erp-mes-profile-1.0.0.json` connector manifest with HTTP REST
  protocol, ERP/MES input profile, output events, compatibility, permissions,
  TCK, SBOM, and rollback metadata.
- Config schema requires a `secretName` reference instead of embedding
  credentials, matching the platform secret posture.
- Connector runtime tests now cover the ERP/MES profile (11 tests in the
  connector suite; 82 total Python tests).

## Verification

```text
python3 -m pytest tests/ -q: 82 passed
python3 -m ruff check src tests: All checks passed
Connector runtime tests: 11 passed
```
