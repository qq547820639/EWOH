# EWOH Frontend / NestJS Inventory

Date: 2026-08-03
Scope: `ewoh-spark-app/` (NestJS + React), `ewoh-feishu-app/` (Express + SQLite + Feishu), `ui/command_map/` (static command map) plus its duplicate under `ewoh-spark-app/client/public/command_map/`.
Constraint: no source files were modified; this report is the only file written.
Verification: every claim in this report was checked against the live worktree on 2026-08-03 and is tagged `confirmed_current` unless explicitly tagged `stale_or_unverified`. The only such tag is the earlier `dist/server/package.json` Jest "haste collision" note from `.codex/artifacts/state.json`, which was not reproduced in the current test run.

## 1. NestJS Modules

### Framework and app bootstrap

- NestJS 10 (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`), Drizzle ORM `0.44.6`, `@lark-apaas/fullstack-nestjs-core` 1.1.57.
- `server/app.module.ts` registers `PlatformModule.forRoot()`, a global `GlobalExceptionFilter`, and these modules: Dashboard, Simulator, Spatial, World, Scheduler, RuleEngine, Ingest, Gamification, then ViewModule last as the fallback.
- `server/main.ts` calls `configureApp(app, { disableSwagger: true })`, sets JSON body limit to 1MB, configures HBS to render `dist/client/index.html`, and listens on `SERVER_HOST` / `SERVER_PORT` (defaults `localhost:3000`).
- `hello` is commented-out template code and exposes no live routes.
- `PlatformModule` injects a platform `req.userContext` (userId, tenantId, appId, roles, etc.) and CSRF middleware, but the EWOH services do not read it. There is no EWOH org context interceptor, no `current_org_id`, no RLS setup, and no request-scoped transaction wrapper. `confirmed_current`.

### Route / service / DB access matrix

| Module | Controller routes | Service responsibility | Drizzle tables used | Guards / org context |
|---|---|---|---|---|
| Dashboard | `GET /api/dashboard/overview`; `GET/POST /api/dashboard/devices`; `PATCH /api/dashboard/devices/:deviceId`; `GET/POST/DELETE /api/dashboard/devices/:deviceId/bindings`; `GET /api/dashboard/events`; `GET /api/dashboard/events/stats`; `POST /api/dashboard/events/:eventId/handle`; `GET /api/dashboard/telemetry/:deviceId`; `GET /api/dashboard/workers` | KPI aggregation, device CRUD/search, spatial-person binding via `ewoh_spatial_entity.extra`, event stats, event handling, worker load aggregation | `ewoh_device`, `ewoh_event`, `ewoh_telemetry`, `ewoh_spatial_entity` | None; no org filtering |
| Ingest | `POST /api/ingest/exoskeleton`; `/exoskeleton/batch`; `/environment`; `/camera`; `/mes`; `/spatial-scan`; `/location` | Validate and map real/simulated frames into telemetry, device upsert, world state, environment, MES as schedule plan, spatial scan upsert; quality checks and raw-ref dedup | `ewoh_device`, `ewoh_telemetry`, `ewoh_event`, `ewoh_event_chain`, `ewoh_spatial_entity`, `ewoh_world_state`, `ewoh_schedule_plan`, `ewoh_environment` | `IngestGuard`: optional `X-Ingest-Key` vs `INGEST_API_KEY` plus in-memory 100 req/min/IP rate limit |
| RuleEngine | No controller | Evaluates 5 rules (`LOW_BATTERY`, `HIGH_LOAD`, `POSTURE_RISK`, `DEVICE_OFFLINE`, `DATA_DEGRADED`), writes events + event chain, 30s in-memory dedup | `ewoh_event`, `ewoh_event_chain`, `ewoh_telemetry`, `ewoh_device` | None |
| Scheduler | `POST /api/scheduler/plans`; `POST /api/scheduler/plans/data-driven`; `GET /api/scheduler/plans`; `GET /api/scheduler/plans/:planId/dispatch-status`; `POST /api/scheduler/plans/:planId/confirm`; `GET /api/scheduler/audit`; `GET/PUT /api/scheduler/weights` | Generates 3 shadow plans, data-driven plans, plan confirm + audit row, dispatch status, in-memory weights/history | `ewoh_schedule_plan`, `ewoh_schedule_audit`, `ewoh_device`, `ewoh_telemetry`, `ewoh_event` | None; weights are in-memory only |
| Simulator | `POST /api/simulator/start`; `POST /api/simulator/stop`; `GET /api/simulator/status` | Auto-starts on module init; 4s main tick for devices/persons/world state and 10s environment tick; writes telemetry, world state, environment, events, device upsert | `ewoh_device`, `ewoh_telemetry`, `ewoh_event`, `ewoh_event_chain`, `ewoh_spatial_entity`, `ewoh_world_state`, `ewoh_environment` | None |
| Spatial | `GET /api/spatial/entities`; `GET /api/spatial/entities/:entityId`; `GET /api/spatial/topology`; `GET /api/spatial/hierarchy` | Read-only spatial entity list/detail, topology, hierarchy tree with cycle guard | `ewoh_spatial_entity`, `ewoh_topology` | None |
| World | `GET /api/world/state`; `GET /api/world/events/chain/:eventId`; `GET /api/world/replay` | Aggregates current persons/devices/workstations/events, event chain, minute-bucketed replay snapshots | `ewoh_spatial_entity`, `ewoh_world_state`, `ewoh_event`, `ewoh_event_chain` | None; no snapshot/delta/cursor protocol |
| Gamification | `GET /api/gamification/role`; `POST /api/gamification/resources/allocate`; `POST /api/gamification/tasks/orchestrate`; `POST /api/gamification/schedule/:planId/dispatch`; `POST /api/gamification/exo/:deviceId/feedback`; `GET /api/gamification/brain/suggestions` | Env-driven player role, resource allocation with offline conflict check, task orchestration/takt simulation, dispatch with conflict audit, exo feedback as event only, brain suggestions from load/battery/events | `ewoh_device`, `ewoh_telemetry`, `ewoh_event`, `ewoh_spatial_entity`, `ewoh_schedule_plan`, `ewoh_schedule_audit` | None; role is read from `EWOH_PLAYER_ROLE` and not enforced on routes |
| View | `GET /` and `GET /*` | Renders `dist/client/index.html` | none | None |

`confirmed_current`.

### Guards, RLS, audit, idempotency

- Only guard in server code is `IngestGuard`. `confirmed_current`.
- No `org_id` columns, RLS policies, `set_config`, transaction-level GUC, `OrgContextInterceptor`, `OrgScopeService`, `AuditService`, `StateMachineGuard`, `ReferenceIntegrityService`, or `IdempotencyService` exist in `ewoh-spark-app/server`. `confirmed_current`.
- Audit is limited to `ewoh_schedule_audit` rows written by Scheduler/Gamification and `ewoh_event.evidence_json` notes. No unified audit log, hash chain, or sensitive-query audit. `confirmed_current`.
- Idempotency is limited to ingest `raw_ref` dedup (`ewoh_telemetry.raw_ref`) plus `record_id` generation; no general `idempotency_key` storage/return pattern. `confirmed_current`.
- No `db.transaction(...)` calls were found; multi-write service flows are not wrapped in request-scoped transactions. `confirmed_current`.

## 2. Drizzle Schema, SQL Scripts, and Authoritative Plan

### Current schema (`server/database/schema.ts`) - 11 tables, `confirmed_current`

- `ewoh_device`: id, device_id, worker_name, device_model, battery_pct, online, last_telemetry_at, source_type, firmware_version, hardware_version, protocol_version, temperature_c, fault_code, last_raw_ref, _created_at, _updated_at.
- `ewoh_event`: id, event_id, device_id, event_code, event_type, severity, title, status, created_at, handler_action, source_type, trigger_record_id, evidence_json, _updated_at.
- `ewoh_telemetry`: id, device_id, ts, pitch_deg, load_score, fatigue_trend, battery_pct, quality_status, source_type, record_id, ingested_at, raw_ref, joint_angles, angular_velocity_dps, assist_level, torque_nm, cumulative_load_score, temperature_c, fault_code, packet_loss_pct, data_confidence, data_quality, _created_at, _updated_at.
- `ewoh_environment`: id, sensor_id, entity_id, temperature, vibration, noise, air_quality, ts, source_type, record_id, data_confidence, _created_at, _updated_at.
- `ewoh_model_registry`: id, model_id, model_name, version, type, status, card_json, _created_at, _updated_at.
- `ewoh_schedule_audit`: id, audit_id, plan_id, action, operator, reason, created_at, _updated_at.
- `ewoh_schedule_plan`: id, plan_id, plan_name, strategy, status, takt_improvement, high_load_persons, low_battery_risk, affected_persons, metrics_json, reason, created_at, confirmed_by, confirmed_at, confirm_reason, _updated_at.
- `ewoh_event_chain`: id, event_id, parent_event_id, causal_type, description, created_at, _updated_at.
- `ewoh_world_state`: id, entity_id, state_json, ts, _created_at, _updated_at.
- `ewoh_topology`: id, from_entity, to_entity, relation, distance, _created_at, _updated_at.
- `ewoh_spatial_entity`: id, entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version, extra, _created_at, _updated_at.

### SQL scripts (`ewoh-spark-app/scripts/`), `confirmed_current`

- `ewoh-schema.sql`: creates `ewoh_device`, `ewoh_event`, `ewoh_telemetry` plus indexes.
- `deepen-schema.sql`: creates `ewoh_spatial_entity`, `ewoh_topology`, `ewoh_world_state`, `ewoh_event_chain`, `ewoh_schedule_plan`, `ewoh_schedule_audit`, `ewoh_model_registry`, `ewoh_environment`, plus spatial/model seed rows.
- `extend-schema-for-real-data.sql`: idempotent ALTERs adding real-data columns to `ewoh_telemetry`, `ewoh_device`, `ewoh_event`, `ewoh_environment`, plus source/record indexes.
- `ewoh-seed.sql`: demo device/event/telemetry seed data.

### Comparison to authoritative plan tables 77/78

- Plan table 77 is titled "36 new tables" but the actual row list enumerates 38 unique `ewoh_*` names (counted from `.codex/artifacts/authoritative-plan.txt`). This is a plan-internal inconsistency. `confirmed_current`.
- Zero of the table-77 names exist in `schema.ts` or SQL scripts. Missing names include organization/person/skill/role, device binding/capability, spatial relation/hierarchy, model asset/binding, workstation family, task family, schedule task family, resource preorder/binding, control family, event rule/action/subscription, world snapshot/delta, system config, knowledge, notification, and audit log. `confirmed_current`.
- Plan table 78 lists 12 existing tables to alter: `ewoh_scheduler_config`, `ewoh_environment`, `ewoh_model_registry`, `ewoh_schedule_audit`, `ewoh_schedule_plan`, `ewoh_event_chain`, `ewoh_world_state`, `ewoh_topology`, `ewoh_spatial_entity`, `ewoh_telemetry`, `ewoh_event`, `ewoh_device`. Current schema/scripts cover 11 of 12; `ewoh_scheduler_config` is absent. `confirmed_current`.
- None of the 11 present tables has `org_id`, RLS, or the table-79 field additions (`z`, `roll`, `pitch`, `bbox_d`, `coordinate_system`, `coordinate_origin`, `floor_elevation`, `unit`, `lifecycle_status`, `runtime_status`, `health_status`, `device_category`, `suggestion_id`, `session_id`, `parent_plan_id`, `is_simulation`, `approval_id`). `confirmed_current`.

## 3. React Client (`ewoh-spark-app/client`)

### Routes (`src/app.tsx`), `confirmed_current`

| Route | Page | Notes |
|---|---|---|
| `/command-map` | `CommandMap` | Full-screen command map outside Layout |
| `/` | `Overview` | Command-center-like KPI page inside Layout |
| `/devices` | `Devices` | Device search/table/drawer |
| `/events` | `Events` | Event/risk dashboard |
| `/workers` | `Workers` | Worker load cards/chart |
| `*` | `NotFound` | Fallback |

No `/command-center`, `/digital-world`, `/scheduling`, `/ai-decision`, `/personnel`, `/alerts`, `/organization`, `/model-management`, `/data-assets`, or `/system` routes.

### API namespaces

- `client/src/api/index.ts` is a placeholder with no exported EWOH namespaces; no `queryKeys.ts` exists. `confirmed_current`.
- Real API files: `dashboard.ts`, `scheduler.ts`, `spatial.ts`, `world.ts`, `gamification.ts`. `confirmed_current`.
- Template business-UI API folders exist under `components/business-ui/api/` (`chats`, `departments`, `user-profiles`, `users`, `files`) but are not used by the EWOH pages. `confirmed_current`.

### React Query keys, `confirmed_current`

`overview`, `events-recent`, `devices`, `devices + searchQuery`, `spatial-entities-all`, `events + statusFilter`, `event-stats`, `workers`, `spatial-entities`, `world-state`, `events-center + statusFilter`, `schedule-plans + statusFilter`, `schedule-audits`, `replay-snapshots`, `workbench-overview`, `workbench-events-open`, `workbench-plans-proposed`, `brain-suggestions`, `alert-toast-l3`, `device-bindings + deviceId`, `spatial-entities/person`, `spatial-hierarchy`.

Keys are ad hoc string arrays; there is no organization-scoped invalidation, no centralized query-key factory, and no stale-data UI contract. `confirmed_current`.

### UI states

- CommandMap panels generally implement loading/error/empty. `confirmed_current`.
- Overview, Devices, Events, and Workers implement loading/empty in places but do not consistently implement error or permission-denied states. `confirmed_current`.
- No page implements the plan's full loading/empty/error/permission-denied/stale-data state matrix. `confirmed_current`.

### 3D stack and map modes

- Uses `@react-three/fiber` 9, `@react-three/drei` 10, `three` 0.185, and `react-zoom-pan-pinch` for 2D. `confirmed_current`.
- `FactoryMap3D.tsx` is used only for `L2`: procedural boxes, capsules, camera cones, UWB hemispheres, `OrbitControls`, `Grid`, `Html`, `useFrame` smoothing. No GLB/GLTF loader, no `InstancedMesh`, no BVH raycasting, no GPU tier detection, no `frameloop="demand"`, no 2D fallback toggle. `confirmed_current`.
- All 9 map modes are implemented in `ModePanel.tsx` / `FactoryMap.tsx`: production, person, exoskeleton, body_load, safety_risk, device, environment, scheduling, data_quality. `confirmed_current`.
- Only L0/L1/L2 exist. L3/L4 are not implemented. `confirmed_current`.

### Permission-aware navigation

- `Layout.tsx` renders a static nav list with no role filtering. `CommandMap` does not gate modes/actions by role. `GamificationService.getRole()` returns env-driven roles/permissions, but the client does not consume it for navigation or authorization. `confirmed_current`.

## 4. Feishu App (`ewoh-feishu-app`)

### Stack and DB, `confirmed_current`

- Express 4, `better-sqlite3`, `cors`, plain JS; `npm run dev` / `npm start` run `server/index.js`.
- SQLite is `:memory:` and seeded on startup; no persistence across restarts.
- Tables: `devices`, `telemetry`, `events`, `rules`, `audit_log` (5 tables), plus indexes on telemetry/events/audit.
- `feishu-config.json` stores plaintext base token, chat id, table ids, workflow config, polling config, and dashboard URLs.

### Endpoints, `confirmed_current`

| Method / path | Purpose |
|---|---|
| `GET /` | Health JSON |
| `GET /api/status` | System stats plus event/device rollups |
| `GET /api/devices` | Device list |
| `GET /api/devices/:device_id` | Device detail |
| `GET /api/devices/:device_id/health` | Health summary from latest telemetry |
| `GET /api/telemetry/latest` | Latest telemetry per device |
| `GET /api/telemetry` | Telemetry list/filter/paging |
| `GET /api/events` | Event list/filter/paging |
| `GET /api/events/:event_id` | Event detail |
| `POST /api/events/:event_id/handle` | Handle event (`acknowledge`, `resolve`, `escalate`, `comment`) |
| `GET /api/rules` | Rule list |
| `GET /api/audit` | Audit log list/filter/paging |
| `GET /api/feishu/report` | Generate Feishu shift report doc |
| `POST /webhook/card` | Feishu card button callbacks (acknowledge/resolve/escalate) |

### Events, simulator, sync, `confirmed_current`

- Event statuses: `open`, `handled`, `closed`; escalate keeps `open` and creates a Feishu approval. Auto-close happens when the rule condition recovers.
- Audit actions: `event_created`, `event_handled`, `event_auto_closed`.
- Simulator: 3 devices, 1 frame/second each, deterministic scenarios (normal, high-risk bend/load, low battery + sensor degradation), writes telemetry/devices and feeds the rule engine.
- Sync: local to Feishu Base for devices/events/telemetry; telemetry buffered and flushed every 5s; full sync every 30s; Feishu event-status polling every 60s writes status changes back to local SQLite.
- Feishu integration uses `lark-cli` subprocess for IM messages/cards, Base record upsert/search/batch create, approval instance creation, and doc creation. Failures are logged and do not block the main loop.
- Frontend: `public/index.html` + `public/js/app.js` with tabs Dashboard, Events, Devices, Audit; canvas charts and 2s polling of telemetry latest.

## 5. Static Command Map (`ui/command_map`)

`confirmed_current`.

- Files: `index.html`, `assets/app.js` + `assets/style.css`, `map/`, `layers/`, `timeline/`, `entity-panel/`, `scenario-panel/`, `event-center/`, `admin/`, `workbench/`.
- `index.html` contains top KPI bar, org tree, 9-mode list, L0/L1/L2 level toggle, SVG map, entity detail panel, bottom tabs (timeline, events, scenario, workbench, admin), and a local-assistant popover.
- `assets/app.js`: bootstrap, sample data, backend API client, state, org tree, topbar, tabs, assistant; declares all 9 map modes.
- `layers.js`: single-active-mode layer selector.
- `map/map.js`: SVG renderer with zones, routes, stations, devices, persons, bindings, camera FOV, UWB coverage, environment heatmap, scheduling prediction layer, and legends.
- `timeline.js`: live/pause/replay, 1x/2x/4x, shift cursor 08:00-17:00, event markers, device replay series, load/battery mini chart.
- `entity-panel.js`: entity details, binding relations, person profile, device health, suggestions, risk trend.
- `event-center.js`: filter list, detail with cause/evidence, handling (confirm/close/dismiss/comment), sensor-conflict site-fact marking.
- `scenario-panel.js`: plan cards, per-metric comparison, human confirm with mandatory reason, session assignments, audit log.
- `workbench.js`: shift overview, pending plans, events needing attention, quick actions, safety red lines.
- `admin.js`: model registry and rule registry stubs; edit/rollback buttons disabled.
- L2 is a placeholder ("GLB/glTF pending"); L3/L4 are absent.
- Data behavior: standalone copy attempts backend `/api/*` endpoints (matching the demo Python server under `delivery/06_Demo_Prototype/server.py`) and falls back to sample data; the copy under `ewoh-spark-app/client/public/command_map/` differs only in `assets/app.js`, which forces sample data when embedded in an iframe. All other files are byte-identical (verified by SHA-256).

## 6. Build / Test Status

### `ewoh-spark-app`, `confirmed_current`

- Package scripts include `dev`, `build`, `build:prod`, `build:server`, `build:client`, `start`, `test`, `test:watch`, `test:e2e`, `eslint`, `stylelint`, `type:check`, `lint`, `format`, `precommit`, `gen:db-schema`, `gen:openapi`.
- `gen:openapi` is `UNSUPPORTED, SKIP`.
- No `server/**/*.spec.ts` files exist and no `test/` directory exists.
- `test:e2e` references `test/e2e/jest.config.js`, which is absent.
- Running `npm test` exits 1 with `No tests found` (0 matches for the configured `testMatch`). `confirmed_current`.
- `dist/server/package.json` exists as a build artifact. `.codex/artifacts/state.json` previously recorded `npm_test: "0 tests found; haste collision from dist/server/package.json"`, but the current `npm test` run did not reproduce the haste collision. The collision claim is therefore `stale_or_unverified`; the "no tests found / exit 1" failure is `confirmed_current`.

### `ewoh-feishu-app`

- Scripts are `dev` and `start` only; no test/build scripts. `confirmed_current`.

### `ui/command_map`

- No package/build system; static HTML/CSS/JS only. `confirmed_current`.

## 7. Gap Analysis

### 11 capability centers

| Center | Plan route | Status |
|---|---|---|
| Command center | `/command-center` | Partial: Overview KPI + CommandMap topbar; no dedicated route, no simplified 3D command view, no role filtering |
| Digital world | `/digital-world` | Partial: CommandMap with L0/L1/L2, entity detail, replay, scheduling mode; no L3/L4, no four modes, no snapshot/delta/cursor, no 2D fallback contract |
| Production scheduling | `/scheduling` | Partial: schedule plan generate/confirm/audit, resource allocation, task orchestration, dispatch API; no real task/resource/approval/execution lifecycle tables or state machines |
| AI decision | `/ai-decision` | Partial: brain suggestions and data-driven plans; no A2/A3 separation, frozen snapshots, versioned plans, risk/uncertainty, adoption records |
| Device center | `/devices` | Partial: device search/create/edit/bind; no 19-dimension search, 12 config classes, lifecycle/runtime/health states, relation graph, full audit |
| Personnel & exoskeleton | `/personnel` | Partial: Workers load page only; no profile, skills, qualifications, binding history, compatibility matrix |
| Risk & alerts | `/alerts` | Partial: Events + event center panel; backend handle API exists but no client mutation; no escalation/reopen/SLA |
| Organization & space | `/organization` | Partial: spatial hierarchy API and hierarchy picker; no organization tree, org_id, relationship graph |
| Model management | `/model-management` | Absent in NestJS/React; static admin stub only |
| Data assets | `/data-assets` | Absent |
| System management | `/system` | Absent |

No center is fully implemented. `confirmed_current`.

### L0-L4

- React CommandMap: L0/L1 (SVG) and L2 (R3F) only; no L3/L4. Static map: L0/L1 plus L2 placeholder. Backend has no L3/L4-specific API. Partial. `confirmed_current`.

### 9 map modes

- Implemented in both React CommandMap and static command map. `confirmed_current`.

### Four modes (observe, schedule, simulate, replay)

- Not implemented as explicit modes. There is a replay toggle, a scheduling map mode, and simulation APIs for task orchestration, but no mode state machine, no shadow branch + approval flow, and no observe/schedule/simulate/replay mode contract. `confirmed_current`.

### 19-dimension device search

- Authoritative dimensions (plan table 70): keyword/name, business ID, category, model, manufacturer, serial, org, spatial location, lifecycle status, runtime status, online/offline, health status, binding status, bound person, protocol type, firmware version, data source, data quality, maintenance status/next maintenance.
- Current direct filters: keyword, model, online/offline, data source (4 of 19). Device business ID is covered through keyword only; protocol/firmware fields are stored but not filterable; remaining dimensions are absent. No pagination or export. `confirmed_current`.

### 12 config classes

- Plan table 72 classes: basic identity, ownership/install, access identity, network access, protocol, collection frequency, reporting rules, alert thresholds, control permissions, firmware, maintenance policy, data quality.
- Current `DeviceConfigDrawer` covers partial basic identity, partial ownership/install via spatial binding, partial access identity via sourceType, partial protocol via protocolVersion, and partial firmware via firmware/hardware versions. There are no 12 accordion panels, no versioning/audit, and no sensitive credential masking. `confirmed_current`.

### Six shared contracts (C1-C6)

- C1 Data, C2 API, C3 State machines, C4 Security, C5 UI, C6 Run/release are defined in the plan and in `.codex/artifacts/contracts/README.md`, but none of the contract files exists yet (`data-contract.md`, `api-contract.md`, `state-machines.md`, `security-contract.md`, `ui-contract.md`, `devops-contract.md` are all "Refining" placeholders).
- No `queryKeys.ts`, no generated OpenAPI (script is `UNSUPPORTED, SKIP`), no state-machine YAML, no RLS/audit security contract implementation, no UI contract enforcement. `confirmed_current`.

## Major Claim Status

- NestJS module inventory, routes, services, DB tables: `confirmed_current`.
- Drizzle schema and SQL script inventory: `confirmed_current`.
- Table 77/78 comparison: `confirmed_current`; note the plan itself lists 38 names under a "36 new tables" heading.
- React routes, API namespaces, React Query keys, UI states, 3D stack, 9 modes, permission navigation: `confirmed_current`.
- Feishu app endpoints, DB tables, events, simulator, sync: `confirmed_current`.
- Static command map modules/features and duplicate copy: `confirmed_current`.
- `npm test` failure ("No tests found", exit 1) and absence of spec files/test dir: `confirmed_current`.
- `dist/server/package.json` Jest haste collision from `state.json`: `stale_or_unverified` (artifact exists, collision not reproduced on 2026-08-03).
- Gap analysis for centers, L0-L4, modes, 19-dim search, 12 config classes, C1-C6 contracts: `confirmed_current` against current code and authoritative plan.
