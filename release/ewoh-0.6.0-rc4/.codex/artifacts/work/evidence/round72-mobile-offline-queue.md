# Round 72 - 2026-08-04 Mobile Offline Pending-Action Queue

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- Added `client/src/lib/offlineQueue.ts` with typed pending actions
  (`transition` / `inspection`), `localStorage` persistence, append/remove/
  clear/read helpers, and corrupt-payload protection.
- Mobile workbench now enqueues offline transitions and quality inspections
  instead of disabling them; the header shows a `待同步 N` badge.
- On reconnect, queued actions flush in order through the real mobile API and
  are removed only after success; a failed item stops the flush for safe retry.
- Offline banner text updated to explain the queue behavior.

## Real command evidence

- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `npm run test:client`: `10 passed, 10 total` suites; `35 passed` tests.
- Server Jest remains `76 suites / 349 tests` (no server changes this round).
- `node scripts/audit-repo-facts.js --strict`: `REPO FACTS AUDIT: 31/31 passed`.

## Remaining next steps

- Photo attachment upload and PWA installability for mobile.
- Idempotency/state guards for control send/receipt, scale mutations, and work
  orchestration decisions/handoffs.
- HTTP+PostgreSQL E2E and RLS acceptance with `EWOH_E2E_RUNTIME_DATABASE_URL`.
- Second/third factory replication drills and partner shadow delivery.
