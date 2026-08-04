---
workItemIds: T-208
kind: test
result: passed
commitSha: 64d237576133b93e73a44a0cb8ac8495f110b877
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T10:00:00.000Z
command: "npm run test:client"
suite: http-e2e
startedAt: 2026-08-04T10:00:00.000Z
completedAt: 2026-08-04T10:00:00.000Z
artifactChecksum: 62791e603510ec7a3cddb012cf77b294640968b49237de65c099ed5ed0039cd6
verifier: AG-00 local gate
expiresAt: 2026-11-02T10:00:00.000Z
---

# Round 95 - E-SOP Versioning and Mandatory Sign-off

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- `POST/GET /api/mes/sops` and `GET /api/mes/sops/:id` manage versioned SOP
  assets using existing `ewoh_asset_package` storage (no new DB tables).
- `POST /api/mes/sops/:id/publish` publishes an SOP; version diff endpoint
  reports added/removed/changed steps.
- Work order steps can bind `sopId/sopVersion/sopMandatory/requiredTools/
  requiredMaterials`; start and report enforce sign-off and confirmations.
- Signatures are persisted in `resultJson.sop.signatures` with actor, tools,
  materials, and timestamp.

## Real command evidence

```text
npm test -- --runInBand
Test Suites: 79 passed, 79 total
Tests:       383 passed, 383 total

npm run test:client -- --runInBand
Test Suites: 13 passed, 13 total
Tests:       46 passed, 46 total

EWOH_E2E_* npm run test:e2e
Tests:       31 passed, 31 total
```

## Interpretation

- The E2E scenario registers two SOP versions, publishes, diffs, creates a
  work order bound to the SOP, rejects unsigned start with
  `SOP_SIGN_REQUIRED`, and verifies signed execution persists.
- This evidence is bound to the code commit that introduced E-SOP versioning
  and sign-off gates.
