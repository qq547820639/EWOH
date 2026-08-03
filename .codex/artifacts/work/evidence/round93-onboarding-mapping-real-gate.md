---
workItemIds: T-204,T-205
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

# Round 93 - Onboarding Real Execution and Mapping Dry Run

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- Onboarding F0 validates site readiness evidence before any factory work.
- Onboarding F2 publishes/verifies each required connector package.
- Onboarding F3 installs/verifies each scenario pack with idempotent DB and
  audit.
- `POST /api/scale/mappings/:id/dry-run` maps a sample payload through rules,
  supports `trim/upper/lower/number/string/default` transforms, and returns
  `REQUIRED_FIELD_MISSING` / `TRANSFORM_ERROR` localized to source and target
  fields.

## Real command evidence

```text
npm test -- --runInBand test/unit/onboarding/onboarding.service.spec.ts test/unit/scale/scale.service.spec.ts
Test Suites: 2 passed, 2 total
Tests:       36 passed, 36 total

EWOH_E2E_* npm run test:e2e
Tests:       29 passed, 29 total
```

## Interpretation

- The onboarding path now performs real persisted operations instead of
  counting golden catalog entries.
- Mapping dry-run is covered by unit tests and the real HTTP+PostgreSQL E2E.
