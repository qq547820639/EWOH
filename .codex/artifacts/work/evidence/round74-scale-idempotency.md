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
