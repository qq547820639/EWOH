---
workItemIds: T-214
kind: evidence
result: failed
commitSha: 93b605dadba097c812cb0b12922a979bb60feaf8
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: 47822008a4bbb06009984c92afd6db08243e1003c1ac9c758cf727c31671ab49
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T16:00:00.000Z
verifier: AG-00 local gate
expiresAt: 2026-11-02T16:00:00.000Z
---

# Round 101 - Pilot Readiness Rerun

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

```text
EWOH_DATABASE_URL=... EWOH_RUNTIME_DATABASE_URL=... \
  bash scripts/pilot-readiness-check.sh

release checksums            PASS
acceptance evidence          PASS
training plan                PASS
deployment runbook           PASS
release manifest             PASS
docker                       FAIL (not available on this machine)
kubectl                      FAIL (not available on this machine)
helm                         FAIL (not available on this machine)
database verify              PASS
runtime database             PASS
pilot factory                PENDING (EWOH_PILOT_FACTORY_NAME not set)
production approval          PENDING (EWOH_PRODUCTION_APPROVAL != approved)
training completed           PENDING (EWOH_TRAINING_COMPLETED != true)
acceptance signoff           PENDING (EWOH_ACCEPTANCE_SIGNOFF != signed)
real device config           PENDING (EWOH_REAL_DEVICE_CONFIG not provided)

Result: passed=7 failed=3 pending=5
PILOT READINESS: NOT READY
```

## Interpretation

- Local code and real PostgreSQL checks pass.
- Production readiness remains blocked by missing local container tools and
  external approval/site inputs.
- G10-G13 remain human-approval gated; this evidence does not replace them.
