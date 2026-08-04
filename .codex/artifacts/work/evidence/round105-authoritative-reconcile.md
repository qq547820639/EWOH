---
workItemIds: T-101
kind: test
result: passed
commitSha: 3eaf1260f3d77840917ae1a327c5da195b431b57
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5536cd5de357143d66490f2976de80518380d679bf8d0d2b2ca163732179af77
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T19:30:00.000Z
verifier: independent verification agent
expiresAt: 2026-11-02T19:30:00.000Z
---

# Round 105 - Authoritative Artifact Reconcile (Phase 1)

Branch: `main` | HEAD: `3eaf1260f3d77840917ae1a327c5da195b431b57`

## Real command evidence

```text
# 1) human-readable reconcile (--strict)
node scripts/reconcile-authoritative-artifacts.js --strict --root .
# exit code 1 (conflicts present, as designed)

# 2) machine-readable JSON reconcile (--strict --json)
node scripts/reconcile-authoritative-artifacts.js --strict --json --root .
# exit code 1; summary passed=3 failed=3 total=6 conflictCount=146 evidenceCount=109 openTaskCount=58

# 3) unit test (ewoh-spark-app)
npx jest test/unit/reconcile-authoritative-artifacts.spec.ts --runInBand
# PASS 5/5 (report structure / version / route manifest / C1 conflict / read-only)
```

## Check items

| Check | Result |
|---|---|
| version_changelog_vs_release_manifest | PASS |
| trace_id_in_phase_state | PASS |
| route_manifest_consistent_with_live_scan | PASS |
| db_table_footprint_reconcile | FAIL (C1: 51-table footprint, reported, not auto-fixed) |
| evidence_structure_complete | FAIL (109 evidence entries, ~108 missing workItemId) |
| open_tasks_have_evidence_or_blocked | FAIL (58 open/in-progress tasks, ~37 without evidence) |

## Interpretation

- The reconcile CLI is read-only and never silently rewrites authoritative sources.
- C1 51-table footprint conflict is truthfully reported (computed vs claimed) and
  left for the canonical-count decision, not auto-fixed.
- Wired into pre-commit (`ewoh-spark-app/scripts/hooks/run-precommit.js` → `runReconcile`)
  and CI (`.github/workflows/test.yml` step「权威制品一致性对账（Phase 1）」).
- Unit tests 5/5 pass; the CLI exits non-zero when conflicts exist.