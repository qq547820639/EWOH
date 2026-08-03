# EWOH Agent Registry

Authoritative role IDs come from the master plan (Final 3.0). Local Codex
subagents are mapped to roles; one subagent may temporarily cover a role but
verification roles stay independent of implementation roles.

| ID | Role | Ownership | Local mapping |
|----|------|-----------|---------------|
| AG-00 | Principal orchestrator | `.codex/artifacts/` plan/state/decision files | root session |
| AG-01 | Requirements baseline | `requirements/`, `docs/product/` | explorer/contract agent |
| AG-02 | Architecture/ADR | `docs/architecture/`, `adr/` | explorer/contract agent |
| AG-03 | Data contract | `db/contracts/`, schema manifest | explorer/contract agent |
| AG-04 | API contract | `openapi/`, `shared/api.interface.ts` | explorer/contract agent |
| AG-05 | State machines | `contracts/state-machines/` | explorer/contract agent |
| AG-06 | Security/permissions | `security/`, `db/policies/` | explorer/contract agent |
| AG-10 | DDL/migrations | `db/migrations/`, `tmp/ddl/` | worker agent |
| AG-11 | Backend shared | `server/modules/shared/` | worker agent |
| AG-12 | Organization/person | `server/modules/organization/` | worker agent |
| AG-13 | Devices/embodiment | `server/modules/devices/`, `embodiment/` | worker agent |
| AG-14 | Spatial/twin | `server/modules/spatial/`, `world/` | worker agent |
| AG-15 | Workstation/model | `server/modules/workstation/`, `model/` | worker agent |
| AG-16 | Task/scheduler | `server/modules/task/`, `scheduler/` | worker agent |
| AG-17 | Resource/material | `server/modules/resource/` | worker agent |
| AG-18 | Alert/approval | `server/modules/alert/`, `approval/` | worker agent |
| AG-19 | Control | `server/modules/control/` | worker agent |
| AG-20 | AI decision | `server/modules/brain/`, `ai/` | worker agent |
| AG-21 | Data governance | `server/modules/data/`, `system/` | worker agent |
| AG-22 | Events/notifications | `server/modules/event-rule/`, `notification/` | worker agent |
| AG-30 | Frontend framework | `client/src/app`, `api`, shared components | worker agent |
| AG-31 | Command map pages | `client/src/pages/CommandMap/` | worker agent |
| AG-32 | Org/device/person pages | corresponding `pages/` | worker agent |
| AG-33 | Scheduling/resource/control pages | corresponding `pages/` | worker agent |
| AG-34 | Alert/audit/config pages | corresponding `pages/` | worker agent |
| AG-35 | AI/data pages | corresponding `pages/` | worker agent |
| AG-40 | DB compile/security verification | `tests/db/`, `reports/` | reviewer agent |
| AG-41 | Requirements trace verification | `reports/traceability/` | reviewer agent |
| AG-42 | API contract verification | `tests/contract/` | reviewer agent |
| AG-43 | State machine/concurrency verification | `tests/state/`, `tests/concurrency/` | reviewer agent |
| AG-44 | UI regression/usability | `tests/e2e/` | reviewer agent |
| AG-45 | AI safety/quality | `tests/ai/`, `evals/` | reviewer agent |
| AG-46 | Performance/reliability | `tests/perf/` | reviewer agent |
| AG-50 | Integration/scenario packages | `integration/`, `fixtures/` | worker agent |
| AG-51 | DevOps/release | `deploy/`, `ops/` | worker agent |
| AG-52 | Docs/training/handover | `docs/delivery/` | worker agent |
| ORCH-01 | Work Graph architecture and contract | `.codex/artifacts/schema/`, `openapi/work-orchestration.yaml` | work orchestration worker |
| ORCH-02 | Artifact parsing, indexing, Git/CI collection | `tools/work-indexer/` | work orchestration worker |
| ORCH-03 | Evidence, gate calculation, expiry | `tools/gate-engine/` | work orchestration worker |
| ORCH-04 | Resource locks, permissions, ownership | `tools/resource-registry/` | work orchestration worker |
| ORCH-05 | Control plane frontend | `tools/work-console/` or `client/src/pages/WorkOrchestration/` | work orchestration worker |
| ORCH-06 | Handoffs, context packs, approval workflow | `tools/handoff-service/` | work orchestration worker |
| PROD-31 | Order-to-Delivery scenario pack | `catalog/scenarios/order-delivery/` | scenario worker |
| PROD-32 | Mobile E-SOP and scan workflows | `catalog/scenarios/mobile-esop/` | scenario worker |
| PROD-33 | Quality and traceability pack | `catalog/scenarios/quality-trace/` | scenario worker |
| INT-31 | ERP/MRP/inventory connectors and mappings | `catalog/connectors/erp/`, `catalog/mappings/` | integration worker |
| VAL-61 | Independent work graph and evidence verification | read-only repo reviews | reviewer agent |
| VAL-62 | Independent factory replication acceptance | factory profiles and TCK evidence | reviewer agent |

## Ownership Matrix (high-conflict files)

| File/dir | Owner | Other agents |
|----------|-------|--------------|
| `db/contracts/schema-manifest.yaml` | AG-03 | submit change requests |
| `openapi/ewoh.yaml` | AG-04 | submit interface proposals |
| `openapi/work-orchestration.yaml` | ORCH-01 | submit interface proposals |
| `contracts/work/work-graph.schema.json` | ORCH-01 | submit schema proposals |
| `contracts/catalog/asset-catalog.schema.json` | ORCH-01/PX-05 | submit schema proposals |
| `contracts/factory/factory-profile.schema.json` | PX-03/PX-07 | submit schema proposals |
| `tools/work-indexer/index.js` | ORCH-02 | submit parser changes |
| `tools/gate-engine/index.js` | ORCH-03 | submit gate rule changes |
| `tools/resource-registry/index.js` | ORCH-04 | submit lock rule changes |
| `tools/handoff-service/index.js` | ORCH-06 | submit handoff changes |
| `shared/api.interface.ts` | AG-04 | codegen only |
| `contracts/state-machines/*` | AG-05 | submit transition proposals |
| `security/access-matrix.yaml` | AG-06 | declare permission needs |
| `client/src/app.tsx`, Layout, queryKeys | AG-30 | submit route registration |
| `server/database/schema.ts` | AG-10/codegen | no manual edits |
| release manifest | AG-51 | provide deploy dependencies |
