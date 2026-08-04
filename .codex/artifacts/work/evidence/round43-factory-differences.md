# Round 43 Evidence - Factory Difference Recycling

Date: 2026-08-03
Scope: Final 5.0 Y4-02 difference recycling and platformization.

## Implemented

- `POST /api/scale/differences` registers a factory-specific difference in
  `ewoh_system_config` under `diff.<factory>.<key>` with category/value/status
  metadata and a `scale.difference.register` audit entry.
- `GET /api/scale/differences` lists org-scoped differences with update
  metadata.
- Unit tests cover registration upsert/audit and listing; E2E registers and
  lists a difference over HTTP.

## Verification

```text
OpenAPI strict audit: 177/177
Scale unit tests: difference register/list passed
HTTP + PostgreSQL E2E: 23/23 passed including difference registry
```
