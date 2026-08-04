---
workItemIds: T-041,T-042,T-043,T-044,T-045,T-046,T-047,T-048,T-049,T-050
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

# EWOH Round 5 CI Evidence

Date: 2026-08-03

## GitHub Actions Full Green

Verification branch: `codex/rc1-ci-full`
Commit: `7474121b8b4be88192ea34750a5db0cd038b6db7`

| Workflow | Run ID | Status |
|----------|--------|--------|
| standalone | 30771638362 | success |
| test | 30771638371 | success |
| security | 30771638372 | success |

## Standalone Workflow Coverage

- Type check, lint, Jest (137), OpenAPI strict audit (106/106)
- Standalone production build
- DDL runner plans
- PostgreSQL 17 migration, RLS, audit, and destructive rollback
- E2E HTTP + PostgreSQL
- Docker image build for `Dockerfile.api` and `Dockerfile.migrate`

## Python Workflow Coverage

- `test`: 667 unittest + 53 pytest + ruff (0 errors)
- `security`: bandit `-ll` (0 medium/high issues)

## Branch History

- `codex/rc1-ci-verify` 3f9a3f0: standalone workflow passed (Docker build included)
- `codex/rc1-ci-full` e9e0eea: full working tree added
- `codex/rc1-ci-full` 7474121: bandit/ruff clean, all three workflows green

## Local Cross-Check

- `scripts/release-drill.sh`: `RELEASE DRILL PASSED`
- Release bundle: `release/ewoh-0.6.0-rc1` with checksums

## Second Wave (2026-08-03)

Backend deepening:
- Org hierarchy wired into `AccessTokenGuard` via `OrgScopeService`.
- Scheduler weight updates persisted to `ewoh_schedule_audit` + audit chain.
- Control create/command/revoke and resource preorder/issue/release audited.
- Rule-engine 30s dedup backed by DB query with in-memory cache.
- Jest: 40 suites / 155 tests; E2E: 11/11.

Frontend UX deepening:
- 10 center pages converted to React Query with polling/stale states.
- Scheduling center has plan generate/confirm mutations.
- DataAssets shows real model registry and system config lists.
- CommandMap L3/L4 filters by focus entity; environment mode shows honest empty state.
- Responsive layout for <1024px; client Jest: 4 suites / 14 tests.

## CI Update

- All later waves are now CI-confirmed on `codex/rc1-ci-full`:
  - `ad3dc10` (second wave): standalone/test/security success.
  - `bb4cd1f` (third wave): standalone/test/security success.
  - `148d989` (fourth wave): standalone/test/security success.
  - `d9f7c99` (fifth wave): standalone/test/security success.
  - `604d831` (sixth wave): standalone/test/security success.
- Seventh-wave commit `3906132` pushed; security success, test/standalone
  still running when API rate limit was hit; conclusion pending next polling.
- Local verification: Jest 41/158, E2E 11/11, typecheck/lint/build pass.

## Third Wave (2026-08-03)

- Device lifecycle update (`device.update`) and event handling (`event.handle`)
  now append audit entries with actor/org/before/after.
- Dashboard controller passes `userContext` into both writes.
- Jest: 41 suites / 156 tests; E2E: 11/11; build pass.
- CI branch: third-wave commit `bb4cd1f` pushed; conclusion pending API window.

## Fourth Wave (2026-08-03)

- Resource inventory persisted in `ewoh_resource_binding`
  (`binding_type='inventory'`, `quantity numeric(18,4)`).
- `issue` uses conditional `quantity >= qty` update + `RETURNING`; `release`
  increments the same row; process lock remains as in-process serializer.
- DDL generator now emits the `quantity` column; verify includes numeric check.
- FakeSqlDb supports `>=`/`<=`/`<`/`>` and arithmetic update assignments.
- Jest: 41 suites / 158 tests; E2E: 11/11; build pass.

## Fifth Wave (2026-08-03)

- `POST /api/scheduler/plans` accepts optional `idempotencyKey`.
- Deterministic plan IDs (`PLAN-<key>-KEEP/CAP/BAL`); repeated key returns
  existing plans instead of inserting duplicates.
- Jest: 41 suites / 159 tests; E2E: 11/11; build pass.

## Sixth Wave (2026-08-03)

- Standalone bootstrap now applies browser security headers:
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `X-XSS-Protection`.
- Unit test added; targeted suite 5/5 and typecheck pass.

## Seventh Wave (2026-08-03)

- Accessibility/UX: skip link, icon-button labels, focus-visible, `aria-live`
  states, contrast fixes, keyboard timeline slider, dialog focus management.
- Client Jest: 5 suites / 19 tests; full Jest 41/160; typecheck/build pass.
- CI: `d9f7c99` full green on GitHub Actions.
- CI: `148d989` full green on GitHub Actions.
- E2E scheduler idempotency case added and verified over HTTP + PostgreSQL;
  E2E count is now 12/12.

## Eighth Wave (2026-08-03)

- New `GET /api/dashboard/environment/summary` returns latest environment
  reading per sensor (temperature/vibration/noise/air quality).
- CommandMap environment mode now reads the real endpoint instead of an empty
  array; empty state remains only when there is genuinely no data.
- Live HTTP smoke: inserted a controlled_test reading and verified the API
  returned it; temp data cleaned after the check.
- OpenAPI route audit: 107 controller operations, 107 documented, 0 gaps.
