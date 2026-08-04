---
workItemIds: [T-071, T-072, T-073, T-074, T-075, T-076, T-077, T-078, T-079, T-080]
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

# EWOH Round 8 Evidence - Org Scope Hardening

Date: 2026-08-03
Scope: remove pre-GUC org-scope fallback warnings and fix a seed-data
corruption bug in the security probe.

## Defects Found

- `AccessTokenGuard` resolved org scope before request GUCs were set. Direct
  `ewoh_organization` reads were RLS-filtered to zero rows, causing
  "Org not found" and a fallback to the token primary org on every login.
- `scripts/verify-standalone-security.js` used fixed fixture UUIDs that
  collided with deterministic seed rows (`10000000-...-0001` is the seed
  "集团A" row), so its cleanup deleted seed organizations after each run.

## Changes Landed

- Added `ewoh_find_org(uuid)` and `ewoh_find_org_children(uuid)`
  `SECURITY DEFINER` functions to the users migration and standalone
  migration/rollback. They resolve the org hierarchy without bypassing RLS on
  business tables.
- `DatabaseOrgHierarchyProvider` now calls those functions instead of reading
  `ewoh_organization` directly before GUC setup.
- Security probe fixtures now use random UUIDs and unique names, so cleanup
  cannot delete seeded organizations.
- Security probe now asserts direct org-table reads without GUC return zero
  rows and the `SECURITY DEFINER` lookup resolves the tenant.

## Verification Results

- `node scripts/verify-standalone-security.js`: PASS, including
  `org_lookup` evidence.
- Login + `/api/me` against the built standalone API: 200 with
  `accessibleOrgIds` resolved; no `Org not found` warnings in server logs.
- Browser regression: login, command center, and command map rendered with
  real data.
- Full release drill: `RELEASE DRILL PASSED` (PG apply/verify/rollback/rebuild,
  security probe, 176 Jest, 107/107 OpenAPI, 14/14 E2E, standalone build).
- Ops drill rerun: `ALL STANDALONE OPS CHECKS PASSED`; logical backup/restore
  of 54 tables / 25 rows with exact count verification and identity smoke.
