---
workItemIds: T-198,T-199,T-200,T-201,T-202
kind: test
result: passed
commitSha: db622540292dd06e65f2b3f068cbaf23de9fa649
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T06:00:00.000Z
command: "npm run test:client"
suite: client-jest
startedAt: 2026-08-04T06:00:00.000Z
completedAt: 2026-08-04T06:00:00.000Z
artifactChecksum: ea13f4e28e68ef1410e265ec2f471f85d198299bd35e44124ff61fd893bd630d
verifier: AG-00 local gate
expiresAt: 2026-11-02T06:00:00.000Z
---

# Round 90 - 2026-08-04 P0 Mobile and Orchestration Hardening

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- Mobile workbench now filters by `assigned_person_id` and request org with
  fail-closed behavior; `worker` role is allowed on the mobile workbench.
- Typed scan recognition supports work order, step, device, material, batch,
  station, and factory references.
- Exception attachments are sanitized and persisted in
  `resultJson.exception.attachments`.
- Offline queue supports `local/queued/syncing/synced/failed/conflict` states;
  one failed item no longer blocks later items, and retry is available in UI.
- Evidence Markdown front matter is parsed and bound to commit/build/env/
  dependency/test metadata; legacy evidence is marked `unbound`.
- `tools/work-console` answers blockers, missing evidence, unblock owners,
  affected tasks, and gates requiring approval.
- Work Graph `--invariants` detects orphan edges, cycles, duplicate IDs, and
  unowned items; Task Graph dependencies now reference real node IDs.

## Real command evidence

```text
bash scripts/standalone-check.sh
ALL STANDALONE CHECKS PASSED

npm test -- --runInBand
Test Suites: 78 passed, 78 total
Tests:       372 passed, 372 total

npm run test:client -- --runInBand
Test Suites: 13 passed, 13 total
Tests:       44 passed, 44 total

node tools/work-indexer/index.js --root . --invariants
Work graph index: 237 items | 19 edges | 48 actors | 89 evidence | 14 gates | 0 conflicts

node tools/work-console/index.js --root . --strict
Work console: 0 blocked | 4 gates need approval | 0 invariant conflicts
```

## Interpretation

- P0-01..P0-07 are closed by code, unit tests, and the one-click standalone
  gate on 2026-08-04.
- G10-G13 remain human-approval gated; this evidence does not replace human
  signoff.
- SOP versioning, inspection schemes, unified world replay, onboarding real
  installs, and true fleet rollback remain in the P1/P2 backlog.
