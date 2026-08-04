# EWOH Round 17 Evidence - Conformance TCK and Factory Profile Replay

Date: 2026-08-03
Scope: Final 5.0 asset conformance checks and factory profile replay/upgrade.

## Changes Landed

- `POST /api/scale/assets/{id}/conformance` runs package-type checks:
  connector runtime/protocol/configSchema/compatibility/outputEvents,
  scenario requires/workflows/policies/acceptance, template modules/
  scenarioPacks, deploy compatibleCore/config, plus semver-like version.
- `POST /api/scale/profiles/{id}/replay` merges template config with profile
  overrides, sets status to `replayed`, updates installed time, and audits.
- OpenAPI: 2 new routes and schemas.

## Verification Results

- NestJS Jest: 52 suites / 213 tests passed.
- HTTP + PostgreSQL E2E: 18/18, including conformance pass on a connector
  package and profile replay with merged config.
- OpenAPI strict audit: 149/149 documented, 0 unimplemented.
- `npm run lint`: passed.
- `RELEASE DRILL PASSED`.

## Next Steps

- Scenario pack installer and fleet upgrade/rollback drill.
- Partner shadow delivery and compatibility directory.
