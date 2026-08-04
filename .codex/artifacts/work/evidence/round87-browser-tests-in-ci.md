---
workItemIds: T-195
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:browser"
suite: browser-playwright
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: e047952361471c3252e4ea5c73753d243fc2f4a235bed6f091af00e860bace8f
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 87 - 2026-08-04 Browser Tests in CI

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- `.github/workflows/standalone.yml` now installs Playwright Chromium
  (`npx playwright install --with-deps chromium`) and runs
  `npm run test:browser` after the HTTP + PostgreSQL E2E step.
- The browser suite executes against the CI PostgreSQL service with the same
  runtime role used by E2E, so authenticated dispatcher flows are verified on
  every push/PR.

## Local evidence

- `npm run test:browser`: 3 passed (command center, command map, mobile
  workbench) against embedded PostgreSQL 17.
- Full standalone gate with runtime DB: `ALL STANDALONE CHECKS PASSED`.

## Remaining next steps

- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
