---
workItemIds: T-216
kind: test
result: passed
commitSha: 3013633c237f1ce9d63f1374e759b173378e2640
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T18:00:00.000Z
verifier: AG-00 local gate
expiresAt: 2026-11-02T18:00:00.000Z
---

# Round 103 - Approval-gated Git Sync Apply

Branch: `codex/ewoh-iteration-2026-08-04`

## Implemented

- `POST /api/work/git-sync/apply` exposes the offline plan apply action but
  fails closed unless `EWOH_WORK_WRITABLE=true`.
- Live GitHub issue creation still requires
  `EWOH_GIT_SYNC_ENABLED/GITHUB_TOKEN/EWOH_GIT_SYNC_APPROVED`.

## Real command evidence

```text
EWOH_E2E_* npm run test:e2e
Tests:       33 passed, 33 total
```

The E2E verifies that a read-only control plane returns 400 with
`EWOH_WORK_WRITABLE is not enabled`.

## Interpretation

- The apply surface exists without weakening approval controls.
- Real GitHub mutation remains disabled by default and human-approved.
