---
workItemIds: [T-191, T-192, T-193, T-194, T-195, T-196, T-197, T-198, T-199, T-200]
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
