---
workItemIds: T-194
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

Running 4 tests using 1 worker
✓ logs in as dispatcher and renders the command center
✓ renders the command map after login
✓ renders the mobile workbench after login
✓ renders the alerts page after login
4 passed (5.8s)
```

Screenshot: `output/playwright/browser-authenticated-command-center.png`
(1440x900).

## Remaining next steps

- Add browser tests for command map and mobile workbench flows.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
