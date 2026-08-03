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
