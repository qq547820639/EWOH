# Round 86 - 2026-08-04 Authenticated Playwright Browser Test

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- Added `@playwright/test` as a dev dependency and `npm run test:browser`.
- Added `playwright.config.ts` (headless, single worker, 1440x900).
- Added `test/browser/authenticated.spec.js`: seeds a dispatcher user through
  the owner PostgreSQL connection, starts the built standalone server, logs in
  through the real UI, waits for `/command-center`, asserts the page text, and
  captures a screenshot.
- The test cleans up the server, user, and organization in `afterAll`.

## Real command evidence

```text
EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@127.0.0.1:55432/postgres' npm run test:browser

Running 1 test using 1 worker
✓ 1 test/browser/authenticated.spec.js › logs in as dispatcher and renders the command center (583ms)
1 passed (3.0s)
```

Screenshot: `output/playwright/browser-authenticated-command-center.png`
(1440x900).

## Remaining next steps

- Add browser tests for command map and mobile workbench flows.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
