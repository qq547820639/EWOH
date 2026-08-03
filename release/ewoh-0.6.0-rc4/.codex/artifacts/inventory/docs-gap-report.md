# Document and Baseline Gap Report

Status: confirmed_current where probed; memory_derived for doc-only claims

## Conflicts

1. Table count conflict: "48 new + 3 altered" logical model vs
   "36 new + 12 altered = 48 managed" physical packaging vs table 77 listing
   38 logical new names.
   Resolution: physical packaging is 36+12; capability mapping matrix is the
   acceptance basis; no capability may be silently dropped.

2. Existing DB is neither model: workspace schema has 18 ewoh tables with
   permissive RLS/grants and no org_id on most tables.
   Resolution: W1 DDL must reconcile existing 18 as altered tables and create
   the missing managed tables; replace loose policies.

3. Makefile used `python`, machine only has `python3`.
   Resolution: `PYTHON ?= python3`; make test/contract now pass.

4. `npm test` failed from dist haste collision and zero specs.
   Resolution: jest ignores dist; harness spec added; npm test passes.

5. Full build failed at prune step due to missing `@vercel/nft`.
   Resolution: added devDependency; `EWOH_SKIP_PLUGIN_INIT=1 npm run build`
   now passes end to end (~71s).

6. API contract is split across docs/api/openapi.yaml (v0.6 seed) and
   delivery OpenAPI (v0.5); target world/control/resource endpoints missing.
   Resolution: AG-04 builds one target OpenAPI from plan section 15 + current
   implementation.

## Gaps

- No org_id/RLS migration, no unified audit hash chain, no world
  snapshot/delta/replay, no control/task-step/resource/approval tables.
- Frontend has 5 routes vs 11 centers.
- Python lint debt 609 errors.
- No NestJS shared org-context/audit/idempotency infrastructure.

## Authority

authoritative-plan Final 3.0 is the master; Final 1.0 and delivery docs are
historical inputs; live code/DB probes override stale document statements.
