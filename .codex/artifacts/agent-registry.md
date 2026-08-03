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

## Ownership Matrix (high-conflict files)

| File/dir | Owner | Other agents |
|----------|-------|--------------|
| `db/contracts/schema-manifest.yaml` | AG-03 | submit change requests |
| `openapi/ewoh.yaml` | AG-04 | submit interface proposals |
| `shared/api.interface.ts` | AG-04 | codegen only |
| `contracts/state-machines/*` | AG-05 | submit transition proposals |
| `security/access-matrix.yaml` | AG-06 | declare permission needs |
| `client/src/app.tsx`, Layout, queryKeys | AG-30 | submit route registration |
| `server/database/schema.ts` | AG-10/codegen | no manual edits |
| release manifest | AG-51 | provide deploy dependencies |
