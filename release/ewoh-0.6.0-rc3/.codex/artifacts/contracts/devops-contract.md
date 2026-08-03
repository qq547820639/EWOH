# DevOps Contract (C6 v1.0)

Owner: AG-51 / AG-46
Status: C6 v1.0 frozen/validated (2026-08-03)
Source: `.github/workflows/{standalone,test,security,package}.yml`,
`Makefile`, `scripts/{standalone-check,standalone-postgres-check,
verify-standalone-security,audit-openapi-routes}.js/sh`,
`deploy/cloud/**`, `openapi/route-manifest.json`,
`.codex/artifacts/work/evidence/{round3,round4}.md`

## CI Workflows

| Workflow | Runs | Scope |
|----------|------|-------|
| standalone.yml | push/PR | Node 22, Postgres 17 service, npm ci, typecheck, lint, Jest, strict OpenAPI route audit, standalone build, DDL plan generation, real PostgreSQL 17 apply/verify/seed/RLS/audit/rollback/rebuild, E2E HTTP+Postgres, Docker image builds |
| test.yml | push/PR | Python 3.11, `make test` (667 unittest), `make test-contract` (53 pytest), ruff, Node typecheck/Jest/prod build with `EWOH_SKIP_PLUGIN_INIT=1`, zero-third-party-dependency guard |
| security.yml | push/PR | bandit `-ll` on `src/edge_platform`, forbidden safety-symbol guard (e-stop / joint torque / assisted closed-loop) |
| package.yml | tag v* | source tarball packaging, credential/artifact exclusions, artifact upload |

## Local Gates

- `scripts/standalone-check.sh`: typecheck, lint, Jest, strict OpenAPI audit,
  E2E when DB env is present, standalone production build, all DDL plans,
  standalone DDL hygiene (no `user_profile`/Miaoda tokens).
- `scripts/standalone-postgres-check.sh`: generates DDL, applies schema/users/
  runtime role, seeds admin, re-applies idempotently, runs
  `verify-standalone-security.js`, destructive rollback to zero EWOH objects,
  rebuild, and repeated verification.
- Round 4 record: 48 managed tables, 48 RLS, 0 missing/loose policies,
  identities/audit function OK; security probe reports role attrs, user
  lookup, RLS A/B, global admin, audit chain OK.

## Test and Build Evidence

| Check | Current result |
|-------|----------------|
| Jest | 39 suites / 122 tests pass (round 4) |
| E2E | 1 suite / 10 HTTP+PostgreSQL tests pass (auth, roles, refresh rotation, org isolation, control/world persistence, approval persistence, system config org scope) |
| Typecheck / lint | server + client pass; ESLint + Stylelint pass |
| Standalone build | `npm run build:prod:standalone` passes (2.15 MB chunk warning) |
| OpenAPI route audit | `scripts/audit-openapi-routes.js --strict`: 106 controller ops, 106 documented, 0 undocumented, 0 unimplemented (`openapi/route-manifest.json`) |
| Python | `make test` 667, `make test-contract` 53, ruff debt reduced 609 -> 76 errors (68 UP031 + 8 E501) and still needs a cleanup wave |

## Deployment Artifacts

- Compose: `deploy/docker-compose.yml`, `deploy/cloud/docker-compose.standalone.yml`
  (secrets required via `${VAR:?}`).
- K8s: namespace, configmap, secret examples, deployment, service, ingress,
  HPA, PDB, migration job; `runAsNonRoot`, `drop ALL`, seccomp, and
  object-storage flag consistent with `REQUIRE_OBJECT_STORAGE` handling.
- Env examples: `deploy/.env.example`, `deploy/cloud/.env.compose.example`,
  `ewoh-spark-app/.env.standalone.example`.

## SLO Targets (contract, not all validated)

- 50 concurrent users via merged requests/cache/unified interface.
- Frontend polling 3-5s foreground, paused background, jitter/exponential
  backoff, cursor rebuild on 410.
- 3D: LOD0 <= 20MB interactive within 5s; LOD1 <= 50MB within 10s; <= 500
  instanced entities; 2D fallback when WebGL2/GPU tier < 1.
- 7x24 critical alerting for API, DB, RLS failures, delta lag, 3D load,
  device online, AI, audit chain.

## Unverified / Not Yet Executed

- Local machine has no Docker or Kubernetes CLI, so container builds and
  cluster apply were not run locally; `standalone.yml` executes Docker image
  builds in CI.
- Production deployment, production DDL apply, credential provisioning, and
  release/rollback drill have not been executed; they remain user-approval
  gated (G10 in-progress).
- Multi-replica Redis rate-limit behavior, per-account login throttling,
  HA failover, and 50-concurrent-user SLO are not validated.
- 7x24 monitoring/alerting stack, 3D LOD budgets, audit-chain daily
  verification job, and DTO-level detail for all 106 OpenAPI operations are
  not yet delivered (route-level strict audit passes; 70 implemented
  operations still lack full DTO docs in the OpenAPI spec).
