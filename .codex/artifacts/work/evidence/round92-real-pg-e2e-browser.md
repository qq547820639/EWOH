---
workItemIds: T-206
kind: test
result: passed
commitSha: ce93fc022c35779ee0bd9c14bebd0f417ae09d78
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T08:00:00.000Z
verifier: AG-00 local gate
expiresAt: 2026-11-02T08:00:00.000Z
---

# Round 92 - Real PostgreSQL E2E and Browser Validation

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

```text
EWOH_E2E_OWNER_DATABASE_URL=postgresql://postgres:...@127.0.0.1:55432/postgres \
EWOH_E2E_RUNTIME_DATABASE_URL=postgresql://ewoh_api:...@127.0.0.1:55432/postgres \
npm run test:e2e
Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total

npm run test:browser
4 passed (6-7s)
```

## Interpretation

- MES mobile workbench scenario passed against real PostgreSQL, covering the
  new person/org filtered workbench and typed scan path.
- Onboarding and mapping real paths were included in the same 29/29 E2E suite.
- Authenticated Playwright flow passed 4/4: command center, command map,
  mobile workbench, and alerts.
