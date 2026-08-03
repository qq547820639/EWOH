# Round 67 Evidence - Pilot Readiness Blocker Gate

Date: 2026-08-03
Scope: Add an executable Go/No-Go readiness gate that surfaces real blockers
for production/pilot release instead of treating local green as deployable.

## Implemented

- `scripts/pilot-readiness-check.sh` + `make pilot-readiness`: checks release
  artifacts, deployment tooling, database/runtime connectivity, pilot factory
  selection, production approval, training completion, acceptance signoff and
  real device config.
- The gate exits non-zero until all checks pass; current local run honestly
  reports `passed=5 failed=3 pending=7`.

## Current Blockers (honest, not fabricated)

```text
docker: not available on this machine
kubectl: not available on this machine
helm: not available on this machine
database verify: EWOH_DATABASE_URL not set
runtime database: EWOH_RUNTIME_DATABASE_URL not set
pilot factory: EWOH_PILOT_FACTORY_NAME not set
production approval: EWOH_PRODUCTION_APPROVAL != approved
training completed: EWOH_TRAINING_COMPLETED != true
acceptance signoff: EWOH_ACCEPTANCE_SIGNOFF != signed
real device config: EWOH_REAL_DEVICE_CONFIG not provided
```

These are the exact approvals/external-state items that must be satisfied by
the Owner before pilot Go/No-Go; local software gates remain green.
