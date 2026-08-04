# Round 71 - 2026-08-04 Validation Pipe and Command-Map Details

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- Global `ValidationPipe` via `APP_PIPE` registered in both `AppModule` and
  `StandaloneAppModule`; `class-validator` errors map to `fieldErrors` and a
  structured `VALIDATION_ERROR` 422 response through
  `server/common/pipes/validation.pipe.ts`.
- Repo-facts gate now includes `validation_pipe_registered` (31 checks).
- Command map person detail now resolves personnel archive fields
  (organization, position, team, skills, risk level, exoskeleton), related
  alerts, recent events, and disposition entry.
- Command map device detail now resolves battery, firmware, protocol, fault
  code, temperature, last telemetry, related alerts, recent events, and
  disposition entry.
- New testable resolver `client/src/pages/CommandMap/entityDetailData.ts` and
  three client tests.

## Real command evidence

- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `npm test -- --runInBand`: `76 passed, 76 total` suites; `349 passed` tests.
- `npm run test:client`: `9 passed, 9 total` suites; `33 passed` tests.
- `node scripts/audit-repo-facts.js --strict`: `REPO FACTS AUDIT: 31/31 passed`.
- OpenAPI route audit remains `232/232` documented, `0` unimplemented.

## Remaining next steps

- Mobile offline queue/PWA and photo attachments.
- Idempotency/state guards for control send/receipt, scale mutations, and work
  orchestration decisions/handoffs.
- HTTP+PostgreSQL E2E and RLS acceptance with `EWOH_E2E_RUNTIME_DATABASE_URL`.
- Second/third factory replication drills and partner shadow delivery.
