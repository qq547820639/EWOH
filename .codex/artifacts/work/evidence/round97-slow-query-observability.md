---
workItemIds: T-210
kind: test
result: passed
commitSha: 98716f200f10587384c6da881f42906589563b14
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T12:00:00.000Z
verifier: AG-00 local gate
expiresAt: 2026-11-02T12:00:00.000Z
---

# Round 97 - Slow Query Observability

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- `RequestDatabaseContext` applies `EWOH_DB_STATEMENT_TIMEOUT_MS` when set and
  records transactions slower than `EWOH_DB_SLOW_THRESHOLD_MS`.
- `GET /api/observability/slow-queries` returns bounded records with
  `requestId`, duration, threshold, and timestamp.
- `/metrics` exposes `ewoh_slow_queries_total`.

## Real command evidence

```text
npm test -- --runInBand
Test Suites: 80 passed, 80 total
Tests:       388 passed, 388 total

npm run test:client -- --runInBand
Test Suites: 13 passed, 13 total
Tests:       46 passed, 46 total

EWOH_E2E_* npm run test:e2e
Tests:       32 passed, 32 total
```

## Interpretation

- Slow transaction recording is unit-tested, and the API/metric are exercised
  by the real PostgreSQL E2E suite.
- This evidence is bound to the code commit that introduced slow-query
  observability.
