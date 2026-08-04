---
workItemIds: T-181
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
artifactChecksum: 90b49a3e6ab1d5db066bb3dfad33e4fcf7fcbffd1c478e1923241735f7559a9d
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

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
