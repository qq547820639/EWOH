# Artifact Schemas

Versioned structural constraints (JSON Schema draft-07) for the authoritative
artifacts in `.codex/artifacts/` and the release files. These schemas are the
single source of truth for the shape of each artifact, so parsers, validators,
and the semantic-consistency rules can agree on the same structure.

## Purpose

Every authoritative artifact is validated against a versioned schema (`$id` of
the form `ewoh:///artifact/<name>/v1`). This guarantees that the fields the
semantic rules rely on (e.g. `verification_state.final_authoritative`,
`env.command` / `env.fingerprint` in the release manifest) are always present
and correctly typed, which is the foundation of the F61-01 "single source of
truth semantic consistency" work.

## Schemas

| # | Schema | Describes | File |
|---|--------|-----------|------|
| 1 | `ewoh:///artifact/state/v1` | `.codex/artifacts/state.json` run state | `state.schema.json` |
| 2 | `ewoh:///artifact/task-board/v1` | Parsed task-board entries | `task-board.schema.json` |
| 3 | `ewoh:///artifact/gate/v1` | Parsed gate entries | `gate.schema.json` |
| 4 | `ewoh:///artifact/risk/v1` | Parsed risk-register entries | `risk.schema.json` |
| 5 | `ewoh:///artifact/decision/v1` | Parsed decision-log entries | `decision.schema.json` |
| 6 | `ewoh:///artifact/evidence/v1` | Evidence front-matter fields | `evidence.schema.json` |
| 7 | `ewoh:///artifact/release-manifest/v1` | `docs/delivery/release-manifest.yaml` and `release/*` | `release-manifest.schema.json` |

All schemas use `additionalProperties: false` and explicit `required` arrays.

## Validation

The repository has `ajv` available via `ewoh-spark-app/node_modules` (it is a
declared dependency of `ewoh-spark-app/package.json`). `index.js` resolves it
with `createRequire` from `ewoh-spark-app/package.json` and falls back to a
minimal structural validator if `ajv` is not resolvable.

Validate a document against a schema:

```js
const { validate, SCHEMAS } = require('./index.js');

const result = validate('ewoh:///artifact/state/v1', stateJson);
// => { valid: boolean, errors: string[] }
```

Or with `ajv` directly:

```js
const Ajv = require('ajv');
const schema = require('./state.schema.json');
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const valid = validate(document); // false → validate.errors
```