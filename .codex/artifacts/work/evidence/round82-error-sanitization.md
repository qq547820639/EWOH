# Round 82 - 2026-08-04 Error Leak Sanitization

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- `GlobalExceptionFilter` no longer serializes raw `HttpException` response
  objects into `details`; only string payloads are copied.
- `WorkOrchestrationService.getSiteReadiness` returns the generic
  `Invalid site readiness report` error for malformed report files instead of
  leaking the underlying exception message.
- Added regression tests for both paths.

## Real command evidence

- `npm test -- --runInBand`: `76 passed, 76 total` suites; `362 passed` tests.
- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.

## Remaining next steps

- Authenticated browser flows still need a dedicated harness.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
