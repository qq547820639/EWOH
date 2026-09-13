# Fresh-install migration repair

Status: full apply, idempotency, rollback and rebuild verified on the disposable local database.

## Confirmed

- Disposable local PostgreSQL 17.11: Docker context `colima-ewoh-local-audit`, container `ewoh-postgres-audit`, database `ewoh`, port `127.0.0.1:55432`.
- `db/runner/standalone-chain.js` derives all 67 registered migration entries from `run_migrations.js`; the directory has no migrations 033 or 055. Explicit dependency 017 precedes 008. Rollback reverses exactly that chain.
- Complete fresh apply succeeded through 069, including 048 shadow isolation and 067 scheduling RLS. The original missing `is_shadow` failure is resolved.
- Local PostgreSQL gate and standalone Compose now consume the shared runner.
- No changes to the Principal-owned DDL generator or its tests. No production operations or commits.
- The schema lock is released only after the final rebuild gate below; the database is left rebuilt at the full applied state for the next E2E phase.

## Current validation and remaining work

- Initial full gate log: `/tmp/ewoh-migration-final-repair.log`.
- Full apply passes; baseline 001, users 002 and runtime role 003 verify pass, and the security verifier passes.
- The check performs a second full apply and passes the final 001 schema and security gates.
- Full reverse rollback passed all 67 entries after fixing standalone_057's UUID comparison and PL/pgSQL loop variable errors. A full rebuild then passed.
- 004 domain count previously expected three tables due to looking in the business manifest; its migration creates six. Runner now derives and cross-checks the table inventory from the 004 migration and verifier artifacts.
- Historical per-migration verify commands remain independently inconsistent in this branch (for example 009, 028, 032 and later specialized checks). Diagnostic log: `/tmp/ewoh-migration-verify-diagnostic.log`. They are not represented as passing evidence; the gate uses the authoritative aggregate schema/security checks.

## Execution Agent contract

Result: full migration apply, idempotency, rollback and rebuild restored and verified.

Assumptions: the specified database is disposable; auth fixtures and credentials are local-only and are not production defaults.

Trace requests: none.

## Extension interface for a future standalone_070

No 070 migration was confirmed or added in this task. To register one, the owner adds the migration and rollback SQL plus matching entries to `FILES`, `EXECUTE_COMMANDS`, the appropriate verify handler table, and the apply/rollback command map in `db/runner/run_migrations.js`. `standalone-chain.js` then discovers the numbered file, validates the registrations and rollback pair, and places it by numeric order. Add a dependency only when the SQL dependency is explicit; encode it in the `dependencies` map so the chain remains the shared source for local checks and Compose.

The chain test fails closed on an unregistered file, missing rollback, duplicate numeric ID or missing verify command. Keep receipt/learning provenance and any fixture credentials local to the verification environment; do not document them as production defaults.
