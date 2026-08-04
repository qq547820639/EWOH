---
workItemIds: T-031,T-032,T-033,T-034,T-035,T-036,T-037,T-038,T-039,T-040
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:e2e"
suite: browser-playwright
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 503ee71da29bcdce2d09db89383677300b1803e7cdf7d12c6cffc218808437e8
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 4 Execution Evidence

Date: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Scope

Run three independent reviews (security, persistence/tenancy, frontend/scenario),
then implement WP-HARDEN-001 in four parallel workers, fix a verify-SQL defect,
and re-run local PostgreSQL/security gates.

## Independent Reviews

- `.codex/artifacts/work/reviews/security-review-2026-08-03.md`: 0 critical,
  4 major, 7 minor, 4 suggestion; `fail` / `fix_required`.
- `.codex/artifacts/work/reviews/persistence-tenancy-2026-08-03.md`: 2 critical,
  5 major, 4 minor, 3 info.
- `.codex/artifacts/work/reviews/frontend-scenario-2026-08-03.md`: 0 critical,
  5 major, 10 minor, 5 suggestion; `fail` / `fix_required`.

## Fixes Landed

- Verify SQL: `policy_missing` scalar-subquery defect fixed in
  `db/verify/standalone_001_verify.sql` and `db/verify/001_verify.sql`.
- Security: RolesGuard default-deny + route-role policy, refresh-token rotation
  with jti revocation + logout, user/trusted-IP rate limiting + TRUST_PROXY,
  `(org_id, config_key)` unique index, system-config upsert target, audit/system
  controller roles, k8s object-storage config.
- Runtime/state: legacy bootstrap requires `EWOH_LEGACY_ENABLED=1` or fails;
  legacy module also gets AccessTokenGuard; interceptor removes broken GUC
  fallback; simulator ticks run in request-scoped transactions with
  `EWOH_SIMULATOR_ORG_ID` and expose `simulationErrorCount`; task/alert/model/
  scheduler transitions are conditional updates with 409; high-risk transitions
  write audit entries in the same request transaction.
- Persistence: control, resource, world-cursor services persist to existing
  `ewoh_control_*`, `ewoh_resource_*`, `ewoh_world_snapshot/delta_log` tables.
  Approval remains an in-memory service aggregate because the frozen 48-table
  DDL has no approval table (decision D-010).
- Frontend: event drill-down/handling, real replay projection, role-gated nav
  and route guard, 403 page, 401 refresh/retry/logout, 3D mode coloring and
  WebGL fallback, plus selected minor fixes.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Jest | `npm test -- --runInBand` | 39 suites / 122 tests pass |
| E2E | `npm run test:e2e` | 1 suite / 10 HTTP+PostgreSQL tests pass |
| Type check | `npm run type:check` | server + client pass |
| Lint | `npm run lint` | eslint + stylelint + typecheck pass |
| Standalone build | `npm run build:prod:standalone` | pass; 2.15 MB chunk warning |
| Standalone DB verify | `db/runner/run_migrations.js --apply-standalone` + `--verify-standalone` | 48 managed, 48 RLS, 0 missing/loose, identities/audit fn OK |
| Security probe | `scripts/verify-standalone-security.js` | role attrs, user lookup, RLS A/B, global admin, audit chain all OK |
| HTTP smoke | `:3101` | health 200/200; unauth API 401 |
| Route audit | `scripts/audit-openapi-routes.js --write-manifest` | 106 controller ops, 0 unimplemented, `openapi/route-manifest.json` |
| Browser UI | Playwright against `http://127.0.0.1:3200` | login, command center, command map, devices, alerts render with real data; no QueryClient/replay 500 after fixes |
| Approval persistence | ApprovalPersistenceService | instances/steps/actions mapped to `ewoh_event` + `ewoh_event_chain` + `ewoh_audit_log`; E2E approval case passes |
| C2 contract | `scripts/audit-openapi-routes.js --strict` | 106/106 documented, 0 undocumented, 0 unimplemented; `openapi/ewoh.yaml` 5368 lines |
| One-click check | `scripts/standalone-check.sh` (with E2E env) | Jest 137, OpenAPI 106/106, E2E 11/11, build, DDL plans, hygiene all pass |
| Performance | `scripts/perf-smoke.js` | 1000 req / 50 concurrency, 6718 qps, p95 14.63ms, 0 failures |
| Contracts | `.codex/artifacts/contracts/` | C1-C6 frozen/validated; G2 passed; requirements trace v1.0 |
| Release drill | `scripts/release-drill.sh` | `RELEASE DRILL PASSED`; destructive rollback/rebuild, security probe, 137 tests, 106/106 OpenAPI, 11/11 E2E, build, DDL hygiene |
| DDL generator | `scripts/generate-ddl-package.js` | `uq_ewoh_scheduler_config_org_key` emitted on regeneration; verify includes `scheduler_config_org_key=1` |
| Release bundle | `scripts/package-release.sh` | `release/ewoh-0.6.0-rc1` created; 566 files; `SHA256SUMS.txt` verify OK |
| Dockerfile lint | `npx dockerfilelint` | `Dockerfile.api` and `Dockerfile.migrate`: 0 issues |

## Browser Regression Fixes

- `client/src/lib/AppContainer.tsx`: added global `QueryClientProvider`; fixed
  `No QueryClient set` failures on CommandMap/Devices and all React Query pages.
- `server/modules/world/world.service.ts`: replaced raw `sql` Date interpolation
  in replay bounds with `lte()` mapping; fixed `/api/world/replay` 500.

## Remaining

- Real HTTP+PostgreSQL E2E suite landed and passes 10/10.
- Approval persistence mapped to existing tables without DDL count change; E2E now 10/10.
- C2 API contract frozen: 106 operations documented, strict audit passes.
- Contract deviation fixes landed: device contract roles, system read/write
  roles, client logout server revocation; E2E 11/11.
- OpenAPI route drift reduced: target device routes implemented, 0 specified
  routes unimplemented; 70 implemented operations still need DTO docs in the
  OpenAPI spec (machine-readable route manifest is authoritative for now).
- Production DDL/deploy remain user approval-gated.
