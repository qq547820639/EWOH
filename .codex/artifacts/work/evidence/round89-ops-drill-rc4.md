---
workItemIds: T-197
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm test"
suite: postgres-gate
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 1087f04b8fa1ef0083decf161fd9a513c2c5b9f26869cd5c9fba2dbc1992d063
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 89 - 2026-08-04 Standalone Ops Drill (RC4)

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

```text
EWOH_OPS_SOURCE_URL=... EWOH_OPS_RESTORE_ADMIN_URL=... EWOH_OPS_RESTORE_DB=ewoh_ops_restore_2026 \
  bash scripts/standalone-ops-check.sh

restore database ready: ewoh_ops_restore_2026
--apply-standalone completed for schema public
--apply-standalone-users completed for schema public
backup written: ... (57 tables)
restore complete: 57 tables, 25 rows
verify complete: 57 tables
identity sequence advanced after restore
ALL STANDALONE OPS CHECKS PASSED
```

## Interpretation

- RC4 logical backup/restore/verify drill passes on embedded PostgreSQL 17.
- Post-restore identity sequence recovery is verified.
- The disposable restore database is created and left for further inspection;
  no production data was touched.

## Remaining next steps

- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
- Real factory replication drills and partner shadow delivery require external
  factory data and signoff.
