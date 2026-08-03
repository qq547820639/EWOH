# Shared Contracts

Each contract has a single owner and a version. Agents consume the contract,
not chat history. C1/C2 are already frozen; C3/C4/C5/C6 were updated on
2026-08-03 to the current implementation and are frozen as v1.0 with their
remaining items listed inside each document.

| Contract | File | Owner | Status | Evidence |
|----------|------|-------|--------|----------|
| C1 Data | `data-contract.md` | AG-03 | v1.1 frozen | live DB probe, DDL + verify SQL, approval equivalent mapping |
| C2 API | `api-contract.md` | AG-04 | v1.0 frozen | `openapi/ewoh.yaml`, route manifest, strict audit 106/106 |
| C3 State machines | `state-machines.md` | AG-05 | v1.0 frozen/validated | service conditional-update 409 tests, E2E control/world/approval persistence |
| C4 Security | `security-contract.md` | AG-06 | v1.0 frozen/validated | security probe, E2E auth/roles/RLS, `security/access-matrix.yaml` |
| C5 UI | `ui-contract.md` | AG-30 | v1.0 frozen/validated | Playwright page captures, `round4.md`, `gates.md` G7 |
| C6 DevOps | `devops-contract.md` | AG-51 | v1.0 frozen/validated | standalone.yml/test.yml/security.yml, standalone checks, route audit |
| C7 Work Graph | `contracts/work/work-graph.schema.json`, `artifact-paths.json` | ORCH-01 | v1.0 validated | indexer CLI, `output/work-graph.json`, `scripts/audit-work-graph-contracts.js` |
| C8 Asset Catalog | `contracts/catalog/asset-catalog.schema.json` | ORCH-01/PX-05 | v1.0 validated | `catalog/` manifests, `scripts/audit-asset-catalog-contracts.js` |
| C9 Factory Profile | `contracts/factory/factory-profile.schema.json` | PX-03/PX-07 | v1.0 validated | `contracts/factory/examples/factory-profile.yaml`, `scripts/audit-factory-profile-contracts.js` |

Supporting inventory: `inventory/frontend-nestjs.md`,
`inventory/ui-devops-inventory.md`, `inventory/environment.md`,
`inventory/docs-gap-report.md`.

Productization event contract: `contracts/events/event-catalog.yaml`
(AsyncAPI 2.6 / CloudEvents 1.0). It is owned by AG-04/AG-22, validated by
`scripts/audit-event-catalog.js`, and exposed by `GET /api/events/catalog`.

Productization factory contract: `contracts/factory/golden-factory.yaml`
(ewoh.io FactoryTemplate). It is owned by PX-03/PX-07, validated by
`scripts/audit-golden-factory.js`, and consumed by
`POST /api/scale/golden-factory/install`.

Productization mapping contract: `contracts/mapping/mapping-schema.json`
(`ewoh:///mapping/v1`). It is owned by PX-05, validated by
`scripts/audit-mapping-contracts.js`, and consumed by `/api/scale/mappings`.

Fleet state machine: `contracts/state-machines/fleet.yaml` freezes upgrade
rings and profile status transitions. It is owned by PX-09 and enforced by
`/api/scale/fleet/upgrade`, `/api/scale/fleet/rollback`, and fleet status.

Policy contract: `contracts/policy/policy-schema.json` (`ewoh:///policy/v1`).
It is owned by PX-06/AG-20, validated by `scripts/audit-policy-contracts.js`,
and consumed by `POST /api/policies/evaluate`.

Workflow contract: `contracts/workflow/workflow-schema.json`
(`ewoh:///workflow/v1`). It is owned by PX-06, validated by
`scripts/audit-workflow-contracts.js`, and consumed by
`POST /api/workflows/advance`.

Freeze scope note: C3-C6 are frozen as contracts for the current real
implementation. Each document explicitly separates service-enforced behavior
from pending items; the pending items do not reopen the contract but define
the next validation wave and completion conditions in
`requirements-trace.md`.

Change flow: change request -> impact analysis -> owner version bump -> AG-00
and verification review -> user approval for scope/security changes -> update
consumers -> rerun verification.
