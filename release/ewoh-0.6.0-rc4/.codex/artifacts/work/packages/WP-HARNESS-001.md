# WP-HARNESS-001 Test Harness and CI Fixes

- package_id: WP-HARNESS-001 v1.0
- owner_agent: AG-51
- validator_agents: AG-40, AG-46
- status: Proposed

## Goal

Make baseline verification reproducible:

- Makefile uses `python3` instead of missing `python`.
- NestJS jest config ignores `dist/` and finds real specs.
- Add first real backend shared tests.
- CI checks contract files, Python tests, lint, type check, and DDL compile.

## Allowed Paths

- `Makefile`
- `ewoh-spark-app/package.json`
- `ewoh-spark-app/jest.config.*` or package jest block
- `.github/workflows/test.yml`
- `tests/**`
- `ewoh-spark-app/test/**`

## Forbidden Paths

- `src/edge_platform/**` business logic (unless required by a separate package)

## Acceptance

- `make test` passes with `python3`.
- `npm test` runs actual Jest specs.
- CI is green for the baseline.
