# Round 81 - 2026-08-04 Request ID and Audit Correlation

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- Added `server/common/request-context.ts` using `AsyncLocalStorage`.
- `TracingInterceptor` runs the handler inside a request context carrying the
  trace id, so downstream services can read the current request id.
- `AuditService.appendAuditLog` now auto-fills `requestId` from the active
  request context when the caller did not supply one.
- Repo-facts gate adds `request_context_correlation` (33 checks total).

## Real command evidence

- `npm test -- --runInBand`: `76 passed, 76 total` suites; `360 passed` tests.
- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `node scripts/audit-repo-facts.js --strict`: `REPO FACTS AUDIT: 33/33 passed`.

## Remaining next steps

- Authenticated browser flows still need a dedicated harness.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
