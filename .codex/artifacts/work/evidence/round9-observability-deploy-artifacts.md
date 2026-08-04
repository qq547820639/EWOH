---
workItemIds: T-089,T-090
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

# EWOH Round 9 Evidence - Observability and Deploy Artifacts

Date: 2026-08-03
Scope: Prometheus metrics endpoint, authenticated business-path performance
smoke, and local deploy artifact verification.

## Changes Landed

- `MetricsModule` adds `GET /metrics` with Prometheus text format:
  HTTP request counters by method/route/status, active requests, process
  uptime, and database readiness check counters.
- `MetricsInterceptor` records every standalone HTTP request; health checks
  feed database readiness counters.
- SPA fallback now excludes `/metrics`; `isSpaFallbackPath` is exported and
  unit-tested.
- `perf-smoke.js` supports `PERF_METHOD`, `PERF_TOKEN`, and `PERF_BODY`, so
  authenticated business routes can be load-tested.
- `scripts/verify-deploy-artifacts.js` validates Kubernetes manifests,
  docker-compose, and Dockerfiles locally without a container runtime.

## Verification Results

- `GET /metrics` returned 200 with `text/plain` Prometheus metrics, including
  `ewoh_http_requests_total`, `ewoh_process_uptime_seconds`,
  `ewoh_http_active_requests`, and `ewoh_db_ready_checks_total`.
- Authenticated business-path smoke: `GET /api/dashboard/overview`,
  200 requests / 25 concurrency, 514 qps, p95 60.93ms, 0 failures.
- `node scripts/verify-deploy-artifacts.js`: 62 checks, 0 failures.
- OpenAPI strict audit: 108/108 documented, 0 unimplemented.
- NestJS Jest: 47 suites / 182 tests passed.
- `RATE_LIMIT_MAX` default of 300/min correctly returned 429 for a 300-request
  burst; the documented business smoke stays under the default limit or runs
  with a higher configured limit.
