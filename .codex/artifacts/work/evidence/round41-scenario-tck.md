---
workItemIds: T-125
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "node scripts/connector-tck.js"
suite: connector
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 3e2ec3d2cd3939c565fe6bcf49c5545315ae9462de0493adce7b38e35afcd92b
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 41 Evidence - Scenario TCK

Date: 2026-08-03
Scope: Final 5.0 Y3-03 scenario TCK.

## Implemented

- Added `scripts/scenario-tck.js` which runs the Golden Factory, policy,
  workflow, mapping, and event catalog contract audits as one scenario
  acceptance gate.
- Added `npm run scenario:tck`.

## Verification

```text
npm run scenario:tck: SCENARIO TCK PASSED (5 gates)
Golden Factory 47 checks, Policy 7, Workflow 16, Mapping 10, Event catalog 13
```
