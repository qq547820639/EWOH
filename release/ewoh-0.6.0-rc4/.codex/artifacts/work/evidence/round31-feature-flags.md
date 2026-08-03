# Round 31 Evidence - Feature Flags

Date: 2026-08-03
Scope: Final 5.0 Y1-06 feature flag/config center.

## Implemented

- `GET/PUT /api/system/feature-flags` and
  `GET/PUT /api/system/feature-flags/:key` persist org-scoped flags in
  `ewoh_system_config` with the `feature.` key prefix.
- Flag payload stores `enabled` plus metadata; writes require `global_admin`,
  reads are available to any authenticated role and stay RLS-isolated.
- Unit tests cover prefix validation, persistence, listing, missing flags, and
  metadata round-trip; E2E verifies org A write/read, org B isolation, and 403
  for non-admin writes.

## Verification

```text
OpenAPI strict audit: 171/171
System feature flag unit tests: passed
HTTP + PostgreSQL E2E: 23/23 passed including feature flag org isolation
```
