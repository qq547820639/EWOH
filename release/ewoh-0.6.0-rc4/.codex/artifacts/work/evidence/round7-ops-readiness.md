# EWOH Round 7 Evidence - Operations Readiness

Date: 2026-08-03
Scope: PostgreSQL logical backup/restore drill, performance smoke, and
operations runbook completion.

## Changes Landed

- `scripts/postgres-logical-backup.mjs`: exports all `ewoh_*` base tables to a
  JSON manifest, restores into an already-migrated database with
  `ON CONFLICT DO NOTHING`, handles `GENERATED ALWAYS AS IDENTITY` columns with
  `OVERRIDING SYSTEM VALUE`, advances sequences after restore, and verifies
  restored row counts.
- `scripts/post-restore-smoke.mjs`: proves identity sequences advance after
  restore by inserting a new `ewoh_world_delta_log` row.
- `scripts/standalone-ops-check.sh`: one-command disposable restore drill.
- `docs/operations/README.md`: alert levels/SOP, fault injection, recovery
  drill, emergency stop, and automated ops checks are no longer placeholders.
- `docs/deployment/README.md`: concrete RPO/RTO, restore, failover, rollback,
  and one-command drill sections.

## Verification Results

### Backup/restore drill

Command:

```bash
EWOH_OPS_SOURCE_URL=... EWOH_OPS_RESTORE_ADMIN_URL=... \
EWOH_OPS_RESTORE_DB=ewoh_ops_restore bash scripts/standalone-ops-check.sh
```

Result:

- Restore database created and schema applied.
- Logical backup exported 54 `ewoh_*` tables.
- Restore completed 54 tables / 24 rows.
- Verify row counts matched source exactly.
- Post-restore identity sequence smoke passed.
- `ALL STANDALONE OPS CHECKS PASSED`

### Performance smoke

Started the built standalone API against PostgreSQL 17 with the non-owner
`ewoh_api` role, then ran:

```bash
PERF_BASE_URL='http://127.0.0.1:3102' PERF_TOTAL=1000 PERF_CONCURRENCY=50 \
  node scripts/perf-smoke.js
```

Result:

```json
{
  "total": 1000,
  "concurrency": 50,
  "ok": 1000,
  "failed": 0,
  "elapsedMs": 202,
  "qps": 4943,
  "p50Ms": 7.42,
  "p95Ms": 17.5
}
```

Health checks returned 200 for `/health/live` and `/health/ready`.

## Residual External Gates

- Production database DDL/deployment/credentials still require explicit user
  approval.
- Local Docker/Kubernetes runtime is still unavailable; container build
  evidence comes from the existing green GitHub Actions workflow.
- Real device/gateway integration, production observability, training delivery,
  business signoff, and follow-on phase acceptance remain external.
