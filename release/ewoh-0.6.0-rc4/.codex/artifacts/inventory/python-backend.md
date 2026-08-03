# Python Backend Inventory

Status: confirmed_current (inspected worktree 2026-08-03)

## Scope

Active Python platform lives in `src/edge_platform/`. Runtime remains
stdlib-only (pyproject dependencies = []). SQLite is the local reference DB;
the authoritative target is NestJS + Drizzle + PostgreSQL.

## Modules

| Module | Capability |
|--------|------------|
| `auth/` | offline identity, session tokens, OIDC backend stub, login lockout |
| `audit/` | structured audit logger with before/after/request id |
| `rbac/` | roles/permissions matrix and export role checks |
| `backup/` | SQLite backup/restore/verify CLI |
| `collection/` | dataset sessions and split manifests |
| `edge/adapters/` | ny_exo_a1, UWB, camera, environment, MES adapters; unified semantic frames |
| `edge/bus.py` | in-process stream bus with bounded ring buffers |
| `edge/exo_semantic.py` | UnifiedExoFrame mapping and vendor-field isolation |
| `edge/bridge/` | edge to spark (Miaoda) bridge |
| `edge/modeling/` | lidar/splat collectors, locator fusion |
| `inference/` | action/fatigue models, rules, pipeline, model cards |
| `perception/` | UWB/vision pose fusion, conflict detection, quality |
| `spatial/` | entities, coordinates, topology, assets, multi-factory registry |
| `world_model/` | state store, event graph, prediction, replay |
| `scheduler/` | constraints, scoring, candidates, orchestrator, appeal, learning loop |
| `scenario/` | five-plan simulation and comparison metrics |
| `governance/` | consent, retention, purge executors, model registry |
| `monitoring/` | Prometheus-style collector/exporter |
| `assistant/` | local LLM template backend, evidence-grounded responses |
| `migrations/` | v001 governance tables |
| `server.py`, `services.py` | HTTP server and storage services |

## HTTP API Surface

`/api/auth/login`, `/api/auth/refresh`, `/api/me`, `/api/status`,
`/api/devices`, `/api/devices/:id`, `/api/devices/:id/health`,
`/api/events`, `/api/event`, `/api/events/:id/comment`, `/api/events/:id/status`,
`/api/query`, `/api/audit`, `/api/models`, `/api/rules`,
`/api/telemetry/export`, `/api/security/policy`, `/api/reset`.

## Database

- Root `demo.db`: 13 tables (person, device, task, telemetry, inference,
  risk_event, audit_log, assignment, consent_record, device_protocol_version,
  event_handling, model_registry, rule_registry).
- `src/edge_platform/demo.db`: 5 base tables.
- Migration `v001_add_governance_tables.py` adds governance tables.
- No org_id/RLS/audit hash chain; SQLite reference only.

## Test Baseline

- `make test`: 667 unittest pass (~23s).
- `make test-contract`: 53 pytest pass.
- `make lint`: 609 ruff errors (legacy style debt; UP006/UP031/import sorting).

## Gaps vs Authoritative Plan

- No org_id multi-tenant model.
- No 48-table DDL, RLS, GUC, or PostgreSQL audit chain.
- No formal task/approval/alert/control state machine services (scheduler has
  shadow/confirm/execute subset).
- No world snapshot/delta cursor protocol.
- No NestJS shared org context/audit/idempotency.
- Python platform remains the local demo/edge engine; NestJS becomes the
  product API surface.
