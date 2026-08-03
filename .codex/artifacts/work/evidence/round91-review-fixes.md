---
workItemIds: T-203
kind: review
result: passed
commitSha: fac2e6f0cf8b559b04b71857c4fa4aa83165b9e2
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T07:00:00.000Z
verifier: AG-00 local gate
expiresAt: 2026-11-02T07:00:00.000Z
---

# Round 91 - 2026-08-04 Independent Review Fixes

Branch: `codex/ewoh-iteration-2026-08-04`

## Review outcome

Independent reviewer found 1 major, 7 minors, and 3 suggestions. This round
fixes the major and the actionable minors:

- Worker write path: `transitionStep` and `qualityInspection` now require
  `assigned_person_id === actor.userId` when `actor.role === 'worker'`
  (`WORKER_STEP_ASSIGNMENT_REQUIRED`).
- Offline queue: failed/conflict items are not replayed automatically,
  conflict items can be discarded in the UI, unknown statuses normalize to
  `local`, and manual retry uses an explicit include-manual path.
- CI: work-indexer runs with `--strict --invariants` in both workflows.
- Scan endpoint handles a missing request body as a 400 instead of a 500.
- Mobile filter test now asserts the person and org predicates in the SQL
  expression, not only that the query builder was called.

## Real command evidence

```text
npm test -- --runInBand
Test Suites: 78 passed, 78 total
Tests:       375 passed, 375 total

npm run test:client -- --runInBand
Test Suites: 13 passed, 13 total
Tests:       46 passed, 46 total

npm run lint
typecheck/eslint/stylelint passed

node tools/work-indexer/index.js --root . --strict --invariants
Work graph index: 238 items | 24 edges | 48 actors | 94 evidence | 14 gates | 0 conflicts

node tools/work-console/index.js --root . --strict
Work console: 0 blocked | 191 missing evidence | 4 gates need approval | 0 invariant conflicts
```

## Interpretation

- The major authorization finding is fixed and covered by unit tests.
- The 191 missing-evidence items are historical task-board rows without bound
  evidence files; they are visible in the console but do not block the gate.
- G10-G13 still require human approval and are not signed by this evidence.
