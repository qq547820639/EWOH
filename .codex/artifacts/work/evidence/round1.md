---
workItemIds: [T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-010]
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

# EWOH Round 1 Execution Evidence

Date: 2026-08-03
Principal trace: EWOH-2026-08-03-principal-001

## 1. Authoritative docs read

- goal-objective.md (attachment)
- EWOH ChatGPT Work multi-agent orchestration plan Final 3.0 (extracted to
  `.codex/artifacts/authoritative-plan.txt`)
- EWOH final product implementation plan Final 1.0 (extracted to
  `.codex/artifacts/final-implementation-plan.txt`)
- delivery/02_技术规范/architecture.md, database.sql, openapi.yaml
- docs/architecture/embodied_factory.md, product_definition.md

## 2. Current baseline

- Python edge platform: `src/edge_platform/`, 667 unit tests, 53 repo contract
  tests, 609 lint debt items.
- NestJS/React app: `ewoh-spark-app/`, 11 Drizzle tables in schema.ts, 5 routes,
  no org context/audit/idempotency infrastructure, no Jest specs initially.
- Dev PostgreSQL reachable: PostgreSQL 17.5, workspace schema has 18 ewoh
  tables, 27 permissive RLS policies, anon/authenticated roles hold DML.
- SQLite demo DBs: 13 and 5 tables.

## 3. Conflicts and gaps

- 48-new+3-altered logical model vs 36-new+12-altered physical packaging vs 38
  names in table 77.
- Existing DB is neither model and has permissive security.
- Makefile used missing `python`; Jest had 0 specs and dist collision; full
  build failed on missing @vercel/nft.
- Frontend had only 5 of 11 centers; no 19-dim search, no L3/L4, no four modes.

## 4. Adopted caliber

- Master baseline: Final 3.0.
- Physical packaging: 36 new + 12 altered = 48 managed tables; capability
  mapping is the acceptance basis.
- User data access through NestJS; authenticated no direct DML; RLS + Service
  org filtering; no auto approval/dispatch/control.

## 5. Agent organization

- AG-00 Principal (root session).
- AG-01..AG-06 contract roles; AG-10 DDL; AG-11 shared backend; AG-30 frontend
  shell; AG-40..AG-52 verification/DevOps roles registered in
  `.codex/artifacts/agent-registry.md`.
- Execution workers: Pauli (DDL), Socrates (shared backend), Noether (frontend
  shell); explorers Cicero/Newton/Galileo/Kuhn contributed inventory.

## 6. First parallel tasks

- Environment probe and baseline tests.
- C1-C6 contract drafts + state machine YAMLs + access matrix + OpenAPI
  skeleton.
- DDL/migration package with manifest, migration, rollback, verify, runner,
  capability map.
- Backend shared infrastructure with 18 Jest tests.
- Frontend 11-center shell with grouped role-aware navigation, placeholders,
  API namespaces, query keys.
- CI/test harness fixes.

## 7. Critical path

Environment probe -> C1/C4 contracts -> DDL/migration -> backend shared
transaction context -> master-data domains -> task/resource state machines ->
scenario integration -> independent verification -> release.

## 8. Gates

- G0 materials accessible: passed.
- G1/G2 requirements and six contracts: draft v1.0 produced; final freeze
  pending verification.
- G3 environment probes: passed with findings; live DDL blocked by role.
- G4 DDL compile/migration: scripts generated and plan mode verified; real
  temp-DB compile pending privileged PostgreSQL.
- G5 backend infrastructure: shared services + tests pass.
- G7 frontend shell: routes compile, lint passes, dev server serves app.

## 9. Immediate actions completed

- `make test`: 667 passed.
- `make test-contract`: 53 passed.
- `npm test`: 18 passed across 7 suites.
- `npm run type:check`, `npm run lint`: passed.
- `EWOH_SKIP_PLUGIN_INIT=1 npm run build`: passed (~99s).
- Dev servers running: NestJS at http://localhost:3000/app/app_17b7bgq1e4a/,
  Vite at http://localhost:8080/app/app_17b7bgq1e4a/ (Vite nested SPA route
  fallback still needs config; NestJS serves the app).

## 10. Blockers

- Current DB role `miaoda_cli_a347335089b96a88` lacks CREATE on the workspace
  schema, so live DDL/verify cannot run. A privileged temporary PostgreSQL or
  an approved dev-DB grant is required.
- Production DB DDL/deploy/credential changes require explicit user approval.
