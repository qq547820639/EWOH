---
workItemIds: T-102
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

# Round 18 Evidence - Fleet Ops + AsyncAPI/CloudEvents Catalog

Date: 2026-08-03
Scope: scenario pack install TCK gate, fleet upgrade/rollback, event catalog.

## Fleet Operations

- `POST /api/scale/scenario-packs/:id/install` requires a passing scenario TCK
  before the package can be installed; non-conformant packages return 400.
- `POST /api/scale/fleet/upgrade` runs package conformance, then marks all
  org-visible factory profiles as `upgraded`.
- `POST /api/scale/fleet/rollback` marks all org-visible factory profiles as
  `rolled_back`.
- Both fleet operations append `scale.fleet.upgrade` / `scale.fleet.rollback`
  audit entries.
- E2E registers a connector and a scenario pack, installs the scenario pack,
  upgrades two factory profiles, rolls the fleet back, and verifies every
  profile row is `rolled_back` in PostgreSQL.

## Event Catalog

- Added AsyncAPI 2.6 contract `contracts/events/event-catalog.yaml` with 13
  CloudEvents 1.0 message types and 13 channels.
- Added `GET /api/events/catalog` and `GET /api/events/catalog/:type` backed by
  `EventCatalogService`; both routes require any authenticated role.
- Added `scripts/audit-event-catalog.js` and `npm run contract:events`; wired
  into `scripts/standalone-check.sh`.
- Docker runtime image now carries `/app/contracts` so the catalog is readable
  in production containers.

## Verification

```text
Event catalog audit: 2.6.0 | 1.0.0 | 13 messages | 13 channels
OpenAPI route audit: controller 154 / spec 154 / documented 154 / unimplemented 0
Jest: 54 suites / 224 tests passed
HTTP + PostgreSQL E2E: 19/19 passed (fresh ewoh_e2e_scale database, 51 managed tables / 51 RLS)
Standalone production build: passed
```
