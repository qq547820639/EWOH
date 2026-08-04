---
workItemIds: T-209
kind: test
result: passed
commitSha: d15fb3410dbd4ea5bd560a9883c64fac7d12b9c5
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T11:00:00.000Z
command: "npm run test:client"
suite: http-e2e
startedAt: 2026-08-04T11:00:00.000Z
completedAt: 2026-08-04T11:00:00.000Z
artifactChecksum: 1e15ca48c0c9222b8cb30d984ff104f9d438fa0ad251c460ec2a5d267ab00cd1
verifier: AG-00 local gate
expiresAt: 2026-11-02T11:00:00.000Z
---

# Round 96 - Quality Scheme Matching and Inspection Gates

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- `GET/POST /api/mes/quality-schemes`, `GET /api/mes/quality-schemes/:id`,
  `POST /api/mes/quality-schemes/:id/publish`, and
  `GET /api/mes/quality-schemes/match`.
- Schemes support `first/in_process/final` stages, required check items,
  device/step/product matching filters.
- `POST /api/mes/work-orders/:id/inspections` accepts `schemeId/stage/
  checkResults`, rejects `QUALITY_STAGE_MISMATCH`,
  `QUALITY_CHECK_REQUIRED`, and `QUALITY_RESULT_MISMATCH`, and persists
  scheme results in `resultJson.quality.scheme`.

## Real command evidence

```text
npm test -- --runInBand
Test Suites: 79 passed, 79 total
Tests:       386 passed, 386 total

npm run test:client -- --runInBand
Test Suites: 13 passed, 13 total
Tests:       46 passed, 46 total

EWOH_E2E_* npm run test:e2e
Tests:       32 passed, 32 total
```

## Interpretation

- The E2E scenario registers and publishes a scheme, verifies auto-match,
  rejects missing required checks and inconsistent results, and persists a
  passing inspection.
- This evidence is bound to the code commit that introduced quality scheme
  matching and inspection gates.
