---
workItemIds: T-190
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm test -- --runInBand"
suite: browser-playwright
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 665eb55f0b28cb6a5de04144da8d2370091e3e49f22501dac8ec88ab3b795fa8
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

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
