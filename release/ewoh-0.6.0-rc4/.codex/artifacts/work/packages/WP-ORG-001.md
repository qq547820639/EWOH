# WP-ORG-001 Organization and Personnel Domain

- package_id: WP-ORG-001 v1.0
- owner_agent: AG-12
- validator_agents: AG-42, AG-44
- status: Validation

## Goal

Implement organization tree and personnel CRUD on the live 18-table schema,
with coarse health privacy, org filter, and binding history read.

## Implemented

- `server/modules/organization/organization.module.ts`
- `organization.service.ts` with buildOrgTree + coarseHealthRisk pure helpers
- `organization.controller.ts` (api/organization, api/personnel)
- client `api/organization.ts`
- real CommandCenter and Personnel pages

## Verification

- `npm run type:check` pass
- `npm run lint` pass
- `npm test` 20 passed / 8 suites

## Next

- Enforce role-based sensitive health access after auth/org context wiring.
- Add org_id scoping when DDL migration is applied.
