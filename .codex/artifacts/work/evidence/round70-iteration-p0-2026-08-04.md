---
workItemIds: T-198,T-199,T-200,T-201,T-202
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

# Round 70 - 2026-08-04 P0 Hardening Iteration

Branch: `codex/ewoh-iteration-2026-08-04`
Baseline: `main` at `aa52250` (`EWOH 0.6.0-rc3 Work Orchestration Control Plane`)

## Real command evidence

- `python3 -m unittest discover -s src/edge_platform/tests`: exit 0 (667 tests).
- `PYTHONPATH=src python3 -m pytest tests/ -q`: `120 passed in 0.53s`.
- `ruff check src/edge_platform`: `All checks passed!`
- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `npm test -- --runInBand`: `75 passed, 75 total` suites; `344 passed` tests.
- `npm run test:client`: `8 passed, 8 total` suites; `30 passed` tests.
- `node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json`:
  `232 controller operations`, `232 spec operations`, `0 undocumented`, `0 unimplemented`.
- `node scripts/audit-repo-facts.js --strict`: `REPO FACTS AUDIT: 30/30 passed`.
- `bash scripts/standalone-check.sh`: `ALL STANDALONE CHECKS PASSED`
  (typecheck, lint, Jest, client Jest, repo facts, OpenAPI and contract audits,
  production standalone build, DDL plans, DDL hygiene).
- Independent reviewer (`reviewer` role): conditional pass, 0 critical, 0 major,
  16 minor + 4 suggestions; reviewer re-ran repo facts, Jest, client tests,
  typecheck, and route audit. See `work/reviews/iteration-review-2026-08-04.md`.
- E2E: skipped in the local gate because `EWOH_E2E_RUNTIME_DATABASE_URL` is unset.

## Changes in this round

- `scripts/audit-repo-facts.js` and `test/unit/repo-facts.spec.ts`: automated
  fact-source consistency gate (30 checks) wired into `scripts/standalone-check.sh`
  and `.github/workflows/test.yml`.
- Unified error contract: `errorCode` alias, `requestId` correlated with tracing
  `x-trace-id`, `retryable`, `recommendedAction`, `details`, OpenAPI `ErrorResponse`.
- Data-source vocabulary: `real / controlled_test / simulated / replayed / stale /
  offline` in `shared/api.interface.ts` and OpenAPI enums; reusable
  `DataSourceBadge` used by the Devices page.
- `RequestDatabaseContext.runInTransaction` reuses an active request transaction;
  regression and inner-failure tests added; failure/GUC semantics documented.
- Mobile workbench: SOP instruction display, pause/resume, exception reporting,
  quality inspection endpoint/API, offline banner, inline retry.
- MES step pause/resume writes `resultJson.exception` / `resultJson.resume`;
  mobile quality inspection delegates to MES quality events.
- Artifacts: README, CHANGELOG, Task Board, Phase State, Gates, Decision Log,
  Risk Register, Task Graph, `state.json`, generated `output/*.json`.

## Independent audits launched

- Noether: org-context/GUC isolation audit. No cross-org leak found; all GUCs
  are transaction-local. Found scheduler nested root transaction (fixed) and
  missing concurrent/rollback/pool-reuse tests (tracked).
- Meitner: frontend data-source/UX audit. Found data-source split and incomplete
  mobile/command-map flows; this round fixed the data-source vocabulary/badge
  and a mobile workbench increment.
- Leibniz: error/API contract audit. Found missing `errorCode/requestId/
  retryable/recommendedAction`, validation-pipe gaps, raw error leak paths, and
  controller/idempotency gaps; this round fixed the envelope fields and
  documented the remaining validation/idempotency work.

## Remaining blockers / next critical path

- HTTP+PostgreSQL E2E and PG RLS acceptance must run in an environment with
  `EWOH_E2E_RUNTIME_DATABASE_URL` set.
- Global `ValidationPipe`/DTO metadata is still missing, so `fieldErrors` is
  emitted only from `BusinessException`.
- Command-map person/device detail panels still lack organization, exoskeleton,
  risk, alerts, recent events, and disposition entry.
- Mobile offline queue and photo attachments are not implemented; current UX
  provides offline indication and manual retry.
- Production DDL/deploy, real device control, and live GitHub issue/PR creation
  remain approval-gated.
