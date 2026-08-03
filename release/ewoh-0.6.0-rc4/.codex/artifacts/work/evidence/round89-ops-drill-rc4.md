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
