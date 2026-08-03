# Round 79 - 2026-08-04 Release Drill and Verification Gates

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

### Release drill

```text
EWOH_DATABASE_URL=postgresql://postgres:ewoh-test-only@127.0.0.1:55432/postgres
EWOH_RUNTIME_DATABASE_URL=postgresql://ewoh_api:ewoh-runtime-test-only-2026@127.0.0.1:55432/postgres
bash scripts/release-drill.sh

ALL POSTGRESQL 17 STANDALONE CHECKS PASSED
Test Suites: 76 passed, 76 total
Tests:       359 passed, 359 total
Test Suites: 12 passed, 12 total
Tests:       39 passed, 39 total
REPO FACTS AUDIT: 32/32 passed
OpenAPI route audit: 232/232, 0 undocumented, 0 unimplemented
HTTP + PostgreSQL E2E: 29/29 passed
ALL STANDALONE CHECKS PASSED
RELEASE DRILL PASSED
```

The drill covers PostgreSQL apply/verify, RLS/auth/audit security probe,
destructive rollback to zero objects, rebuild, full standalone gate, E2E,
production standalone build, and DDL hygiene.

### Performance smoke

```text
PERF_BASE_URL=http://127.0.0.1:3100 PERF_TOTAL=500 PERF_CONCURRENCY=50
GET /health/live -> 500 ok, 0 failed, 4610 qps, p50 4.77ms, p95 26.83ms
```

### Standalone security probe

```text
runtime_role: LOGIN, NOBYPASSRLS, least-privilege attributes verified
user_lookup: direct table read denied; SECURITY DEFINER lookup returned one active user
org_lookup: direct org table read denied; SECURITY DEFINER org lookup resolves tenant
rls: org A positive read/update, org B negative read/update/insert, global admin read verified
audit: two-entry SHA-256 chain recomputed; cross-org append and direct tampering denied
STANDALONE SECURITY VERIFY OK
```

### Not executed locally

- `bandit -r src/edge_platform -ll` could not run because `bandit` is not
  installed on this machine; CI (`security.yml`) still covers it.

## Remaining next steps

- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
