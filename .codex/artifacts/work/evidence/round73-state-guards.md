# Round 73 - 2026-08-04 Control and Work Orchestration State Guards

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- `ControlService.sendCommand` rejects commands on terminal requests
  (`executed`/`timeout`) and rejects duplicate sends while an attempt is
  `pending`/`sent`/`gateway_received`; failed requests remain retryable.
- `ControlService.receiveReceipt` rejects receipts on terminal requests and
  duplicate receipts for an already-terminal attempt.
- Work orchestration handoffs now use a strict state machine:
  `open -> accepted/rejected -> closed`; illegal transitions return 400.
- Gate decisions are idempotent on identical repeats; changed decisions archive
  the previous record to `work/gate-decision-history.json` before overwriting.

## Real command evidence

- `npm test -- --runInBand`: `76 passed, 76 total` suites; `355 passed` tests.
- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- Client tests remain `10 suites / 35 tests` (no client changes this round).

## Remaining next steps

- Scale mutation idempotency/state guards.
- Mobile photo attachment upload and PWA installability.
- HTTP+PostgreSQL E2E and RLS acceptance with `EWOH_E2E_RUNTIME_DATABASE_URL`.
- Second/third factory replication drills and partner shadow delivery.
