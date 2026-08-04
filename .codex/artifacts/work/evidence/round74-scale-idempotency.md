---
workItemIds: T-182
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm test -- --runInBand"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: bc4592ce153e43d02c9c8e3a2391c0a7c4913dd629e11e070e7a7292aedd9117
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 74 - 2026-08-04 Scale Mutation Idempotency

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- `installScenarioPack` returns the existing row when already `installed`.
- `uninstallScenarioPack` returns the existing row when already `uninstalled`.
- `fleetUpgrade` skips profiles already `upgraded`; `fleetRollback` skips
  profiles already `rolled_back`, so repeated fleet operations are idempotent.
- `resolveFactoryDifference` returns the row directly when already `resolved`.
- Added 4 unit tests covering the idempotent paths.

## Real command evidence

- `npm test -- --runInBand`: `76 passed, 76 total` suites; `359 passed` tests.
- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- Client tests remain `10 suites / 35 tests` (no client changes this round).

## Remaining next steps

- Mobile photo attachment upload and PWA installability.
- HTTP+PostgreSQL E2E and RLS acceptance with `EWOH_E2E_RUNTIME_DATABASE_URL`.
- Second/third factory replication drills and partner shadow delivery.
