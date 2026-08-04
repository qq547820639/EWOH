---
workItemIds: T-149
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "node scripts/deployment-tck.js"
suite: deployment
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 1dec703db607a3ccdf8435f0a8eab817d3f1f5edf2ec61e65d6555cbfe8e11cc
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 65 Evidence - RC2 Release Bundle Rerolled

Date: 2026-08-03
Scope: Rebuild the 0.6.0-rc2 release bundle so all new capabilities are in the
deliverable, not only in the working tree.

## Implemented

- Ran `EWOH_RELEASE_VERSION=0.6.0-rc2 bash scripts/package-release.sh`.
- Release bundle regenerated with application source, Python edge platform,
  contracts, migrations, deployment artifacts, docs, evidence, and new
  checksums.
- Bundle now contains 1315 files (was 1260) and passes Scale Release Review
  (24/24).

## Verification

```text
Release bundle: release/ewoh-0.6.0-rc2 (13M)
Files: 1315
SHA256SUMS: regenerated
scale-release-review: 24/24 PASSED
```
