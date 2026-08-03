# Round 20 Evidence - Golden Factory Profile

Date: 2026-08-03
Scope: Final 5.0 Y2-01 Golden Factory Profile and M3 profile re-install path.

## Implemented

- Added `contracts/factory/golden-factory.yaml` as the versioned Golden
  Factory manifest: 7 modules, 3 required connectors, 4 scenario packs,
  compatible core range, and factory defaults.
- `POST /api/scale/golden-factory/install` builds or reuses the published
  golden template, publishes required connectors, installs scenario packs
  through the TCK gate, and installs or reuses a factory profile by name.
- The operation is deterministic and idempotent: same factory name returns
  the existing profile with `reused: true`; every step writes audit entries.
- Added `scripts/audit-golden-factory.js` (47 checks), `npm run contract:golden`,
  and `test/contract/golden-factory.spec.ts`.
- E2E now installs the Golden Factory twice, verifies 3 connectors, 4 scenario
  packs, the published template, the installed profile, org scoping, and
  idempotent reuse.

## Verification

```text
Golden factory audit: ewoh-golden-standard 1.0.0 | 7 modules | 3 connectors | 4 scenario packs | 47 checks passed
OpenAPI strict audit: 155/155
HTTP + PostgreSQL E2E: 19/19 passed including golden factory install/reuse
```
