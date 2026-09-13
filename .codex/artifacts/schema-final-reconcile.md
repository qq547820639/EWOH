# Schema final reconcile

Date: 2026-09-10

Status: complete after the durable 68-core-table verifier repair below. The initial validation section records the earlier repair; the final section supersedes it for verifier generation.

## Authoritative footprint

`db/contracts/schema-manifest.yaml` was restored from `HEAD` and remains the complete final migration registration. Its authoritative header and list agree at:

- `managed_count: 74`
- `physical_create_count: 77`
- `managed_tables` entries: 74
- six `F61-02` domain tables are included in the total and are verified separately; `additional_hardened_existing_tables` are separate existing-table registrations and are not added to the managed count.

The legacy `scripts/generate-ddl-package.js` generator previously rewrote this file with its 001-era 57-table package. It now validates that the existing manifest is present and at least 74/77 before generating legacy 001 SQL artifacts, and it no longer writes `db/contracts/schema-manifest.yaml`. The check fails closed for a missing or reduced manifest. An isolated generator run preserved the manifest checksum and reported `74/77`.

## Rollback contracts

`standalone_001_schema.rollback.sql` is generated from the standalone 001 schema table declarations and drops every one of its 56 tables with `DROP TABLE IF EXISTS ... CASCADE`, including `ewoh_ai_suggestion`. This is correct for an independent empty standalone database that owns the schema.

The managed legacy rollback remains separate and protective: it does not drop existing `ewoh_ai_suggestion`; it removes managed policies and reverses the additive org/RLS changes. The scenario smoke test now checks both contracts and keeps the destructive rollback authorization assertion.

`generate-standalone-ddl.js` remains import-safe under its `require.main` guard. Its rollback renderer is deterministic; rendering the checked-in standalone schema reproduced the checked-in rollback byte-for-byte.

## Validation

Commands run from `/Volumes/Extra/CodeProj/EWOH`:

- `npx jest --runInBand --runTestsByPath test/unit/reconcile-authoritative-artifacts.spec.ts test/unit/repo-facts.spec.ts test/unit/scripts/standalone-ddl.spec.ts test/scenarios/scenario-packages.spec.ts --silent`
  - **PASS: 4 suites, 17 tests**
- `node scripts/audit-repo-facts.js`
  - **PASS: 39/39**
- `node scripts/reconcile-authoritative-artifacts.js`
  - **PASS: 6/6**, including `computed=74`, `changelog=74`, `state.json=74`, `release-manifest=74`
- `node --check scripts/generate-ddl-package.js`
  - **PASS**
- `node --check scripts/generate-standalone-ddl.js`
  - **PASS**
- deterministic standalone rollback render comparison
  - **PASS**, 56 tables
- isolated legacy generator run with a copied 74/77 manifest
  - **PASS**, manifest unchanged
- `git diff --check`
  - **PASS**

No database rollback or database mutation command was executed. No receipt code, application e2e code, migration apply logic, or `FactoryOperations` code was changed for this repair.

## Final verifier generation repair (2026-09-10)

The initial repair preserved the final manifest but left `renderVerify()` consuming the legacy 001 constants. Running `generate-ddl-package.js` followed by `generate-standalone-ddl.js` therefore regenerated only 51 expected tables, while the runner requires the manifest's 68 core tables. The reported missing closing `),` was already corrected in the working files when this follow-up began; regeneration and regression tests now preserve the complete CTE syntax.

### Final implementation

- `scripts/generate-ddl-package.js` parses the authoritative manifest with the application's existing `js-yaml` dependency. Core verification uses `managed_tables` minus the same six named F61-02 domain tables excluded by the runner. The current result is 74 total / 68 core; future valid manifest registrations are incorporated automatically without changing a hard-coded core count.
- Manifest validation rejects absent/noninteger counts, reduced counts, mismatched entry counts, invalid/duplicate names, unsupported org policies, and missing domain registrations before any package output is written. The final manifest remains an input and is never written by the generator.
- Both `db/verify/001_verify.sql` and `db/verify/standalone_001_verify.sql` were regenerated from the same render result. Their expected CTEs contain 68 tables and a closing `),` before `request_scoped`. The standalone transform remains the source for standalone role/schema substitution.
- The NOT NULL check follows each core table's declared `org_id_policy`. It now covers later tenant tables, while `ewoh_trace_span` remains in the 68-table presence/RLS checks and retains its declared nullable `GLOBAL_SHARED` lineage. Existing request-default, policy, privilege, identity, function and index checks remain active.
- No runner implementation, manifest entries, table schema, application code, or migration chain was changed in this follow-up. The manifest SHA-256 remains `b4a17fbcb3a49de487a7ed39f7be32f552fb19f69f9d4eaab8c54ca18052696a`.

### Regression and validation

From `ewoh-spark-app/`:

```sh
npx jest --runInBand --runTestsByPath test/unit/scripts/standalone-ddl.spec.ts test/unit/reconcile-authoritative-artifacts.spec.ts test/unit/repo-facts.spec.ts test/scenarios/scenario-packages.spec.ts --silent
./node_modules/.bin/tsc --noEmit --project tsconfig.spec.json --pretty false
```

- Focused Jest: **4 suites / 25 tests passed**. Log: `/tmp/ewoh-generator-verify-jest.log`.
- TypeScript spec project: **exit 0**. Log: `/tmp/ewoh-verify-typecheck.log`.
- New regression coverage runs both actual generator CLIs twice in an isolated temporary repository copy, checks the manifest remains byte-identical, checks both generated SQL files against their checked-in artifacts, and checks complete expected-CTE grammar rather than only counting quoted names. It also exercises a future 75-total / 69-core manifest, rejects malformed manifests before output writes, and verifies the nullable trace-span contract.
- Repository checks: `node scripts/audit-repo-facts.js` **39/39**; `node scripts/reconcile-authoritative-artifacts.js` **6/6**; both generator `node --check` commands and `git diff --check` passed.
- PostgreSQL 17.11: the complete standalone verifier executed successfully within an explicit `BEGIN READ ONLY` transaction against the existing migrated local database. `node db/runner/run_migrations.js --verify-standalone` then passed the runner's set reconciliation and all 14 result assertions with DDL/rollback authorization unset. Log: `/tmp/ewoh-verify-runner-readonly.log`.

| Verifier metric | Result |
| --- | --- |
| `managed_table_count` / `rls_enabled` | 68 / 68 |
| Missing org column/default, NOT NULL violation, missing/loose policies, authenticated DML, anonymous grants, quantity mismatch | all 0 |
| Audit identity / world-delta identity / audit function / scheduler-config index | all 1 |

The shared `ewoh` database received only read-only verification queries. No apply, seed, rollback, role mutation, or full destructive database chain ran in this follow-up. The earlier full-chain result is historical evidence, not a newly executed full-chain claim.
