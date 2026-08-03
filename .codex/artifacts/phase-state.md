# EWOH Phase State

Updated: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Current Phase

RC2 hardening + ops readiness + org scope hardening: canonical ingestion, M2M
org context, gamification persistence, logical backup/restore drill, ops
runbooks, and warning-free org scope resolution are implemented and validated;
observability and deploy artifact verification are also complete; next
workflow is OEE/andon, quality traceability, ERP connector, then training and
the production approval gate.

## Just Completed

- Three independent reviews (security, persistence/tenancy, frontend/scenario)
  and WP-HARDEN-001 fixes across RBAC, refresh rotation/logout, rate limiting,
  system config unique index, simulator GUC context, conditional state
  transitions, audit wiring, domain persistence, and frontend command map.
- Full Jest regression: 39 suites / 122 tests; E2E HTTP+PostgreSQL: 9/9.
- PostgreSQL standalone apply/verify (48/48) and security probe pass.
- Route audit: 106 controller operations, 0 unimplemented.
- Ingestion protocol aligned to `UnifiedExoFrame.to_storage_dict()` canonical
  shape; `X-Org-Id` M2M tenant context; `assist_level real`; 44 Jest suites /
  176 tests; HTTP+PostgreSQL E2E 14/14; pytest 59.
- Ops readiness: logical backup/restore of 54 tables PASSED, post-restore
  identity smoke PASSED, perf smoke 4943 qps / p95 17.50ms, operations and
  deployment runbooks completed.
- Org scope hardening: `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` lookup PASSED; security probe fixtures randomized;
  browser login resolves scope without fallback warnings.
- Observability: `GET /metrics` Prometheus output verified; business-path
  perf 514 qps / p95 60.93ms; deploy artifact verifier 62/62.
- Final 4.0 adopted as master baseline; MES P0 work order/step/material/
  inspection closed loop is implemented and verified end to end.
- OEE/andon closed loop: device status timeline, OEE calculation, andon state
  machine, and SLA escalation notification are implemented and verified.
- ERP connector: idempotent inbound orders, outbound queue with ack, and
  reconciliation summary are implemented and verified.
- Quality trace graph and mobile workbench API are implemented and verified.
- Mobile workbench React page is implemented and verified with client tests.

## Active Tasks

- RC2 release drill and bundle regeneration (drill PASSED, bundle exists).
- OEE/andon (WP-OEE-01) and ERP connector (WP-ERP-01).
- Training/acceptance evidence and production gate preparation.
- Production DDL/deploy approval gate.

## Dependencies

- Next implementation package depends on the persistence and workflow audits.
- W5 security closure depends on Banach's independent review and any required
  correction loop.
- Production deploy and production DDL remain user approval-gated.

## Exit Criteria

- Independent findings are source-referenced and severity-ranked.
- All critical/major security findings are fixed and re-reviewed.
- The next bounded end-to-end workflow has explicit backend, frontend, data,
  and test ownership with no write conflicts.

## Next Action

Finalize RC2 bundle with Final 4.0 + MES P0 evidence, then implement OEE/andon
and ERP connector before training/acceptance. Production DDL/deploy remain
approval-gated.
