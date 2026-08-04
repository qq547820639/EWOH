---
workItemIds: T-152
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 68 Evidence - Release Bundle Includes Pilot Gate

Date: 2026-08-03
Scope: Rebuild RC2 bundle after adding the pilot readiness gate so the
deliverable is current.

## Verification

```text
release/ewoh-0.6.0-rc2: 1316 files
SHA256SUMS.txt: regenerated
scale-release-review: 24/24 PASSED
pilot-readiness-check.sh: included in bundle
```

The release manifest and acceptance evidence now reference 1316 files.
