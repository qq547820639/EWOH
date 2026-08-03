# UI / DevOps Inventory

Status: `confirmed_current` for files listed below (read directly from the
worktree on 2026-08-03); `stale_or_unverified` for plan targets and for any
behavior not executed during this pass.

Scope: frontend routes/pages, API client namespaces, Command Map features,
deploy files, CI workflows, and gaps against the authoritative UI/DevOps
contracts. This report deliberately does not duplicate the full
`frontend-nestjs.md` ownership report.

## 1. Current Frontend Routes

`ewoh-spark-app/client/src/app.tsx`:

| Route | Page | Layout |
|-------|------|--------|
| `/` | `Overview` | `Layout` sidebar |
| `/devices` | `Devices` | `Layout` sidebar |
| `/events` | `Events` | `Layout` sidebar |
| `/workers` | `Workers` | `Layout` sidebar |
| `/command-map` | `CommandMap` | Fullscreen, no sidebar |
| `*` | `NotFound` | None |

Target routes from the UI contract (`/command-center`, `/digital-world`,
`/scheduling`, `/ai-decision`, `/personnel`, `/alerts`, `/organization`,
`/model-management`, `/data-assets`, `/system`) are not implemented.

## 2. Current Pages and Components

| File | Role |
|------|------|
| `client/src/pages/Overview/Overview.tsx` | KPI cards, recent events, device status, command map entry |
| `client/src/pages/Devices/Devices.tsx` | Device search/filter/sort, battery chart, table, create/edit/bind |
| `client/src/pages/Devices/DeviceConfigDrawer.tsx` | Device create/edit/bind drawer |
| `client/src/pages/Workers/Workers.tsx` | Personnel load chart and cards |
| `client/src/pages/Events/Events.tsx` | Severity pie, trend line, event list with status filter |
| `client/src/pages/CommandMap/CommandMap.tsx` | Fullscreen command map shell, tabs, keyboard shortcuts, mode/level state |
| `client/src/pages/CommandMap/FactoryMap.tsx` | 2D SVG map for L0/L1, 9 modes, camera/UWB overlays, flow/WIP |
| `client/src/pages/CommandMap/FactoryMap3D.tsx` | R3F 3D scene for L2, boxes/capsules/camera cones/UWB spheres |
| `client/src/pages/CommandMap/TopBar.tsx`, `ModePanel.tsx`, `EntityDetail.tsx` | Top KPI/search, mode selector, entity sidebar |
| `client/src/pages/CommandMap/panels/*.tsx` | Timeline, event center, schedule, workbench, resource pool, orchestration, brain |
| `client/src/pages/ExamplePage/ExamplePage.tsx`, `NotFound.tsx` | Template/not-found pages |
| `client/src/components/Layout.tsx` | Sidebar nav: Overview, Devices, Events, Workers, Command Map |

Static command map exists at `ui/command_map/index.html` with assets in
`ui/command_map/assets/`, `map/`, `layers/`, `timeline/`, `entity-panel/`,
`scenario-panel/`, `event-center/`, `admin/`, `workbench/`, and a copy under
`ewoh-spark-app/client/public/command_map/`.

## 3. Command Map Feature Inventory

Current React CommandMap:

- 9 modes: `production`, `person`, `exoskeleton`, `body_load`, `safety_risk`,
  `device`, `environment`, `scheduling`, `data_quality`.
- Levels: `L0`, `L1` (2D SVG) and `L2` (3D R3F); no L3 or L4.
- Bottom tabs: timeline, events, schedule, workbench, resource, orchestration, brain.
- Keyboard shortcuts: `1-9` modes, `L` level, `T` replay, space, Esc, F, `/`, `?`.
- Polling: world state every 2s, overview every 5s, spatial entities every 30s.
- Replay state exists but is local UI state; no verified server-side replay contract.
- URL integration: `event_id` opens the events tab and selects related entity.
- No role filtering, permission denied state, stale data state, or WebGL fallback.

Static command map (`ui/command_map`):

- 9 modes, org tree, entity detail, timeline, events, scenario comparison,
  workbench, admin model/rules, local assistant placeholder.
- L0 SVG, L1 2.5D overlays, L2 GLB placeholder.
- Backend bootstrap fallback to sample data; 2s dynamic polling; source label
  `real` / `controlled_test` / `simulated`.
- API base from `?api_base=` or `localStorage.ewoh_api_base`, default port 8765.

## 4. API Client Namespaces

Current client API files:

| File | Functions / endpoints |
|------|----------------------|
| `client/src/api/index.ts` | Empty stub; target namespace file not implemented |
| `client/src/api/dashboard.ts` | `/api/dashboard/overview`, `/devices` GET/POST/PATCH, bindings GET/POST/DELETE, `/events`, `/events/stats`, `/telemetry/:id`, `/workers` |
| `client/src/api/spatial.ts` | `/api/spatial/entities`, `/entities/:entityId`, `/topology`, `/hierarchy` |
| `client/src/api/world.ts` | `/api/world/state`, `/events/chain/:eventId`, `/replay` |
| `client/src/api/scheduler.ts` | `/api/scheduler/plans` GET/POST, `/plans/:id/confirm`, `/audit`, `/weights` GET/PUT |
| `client/src/api/gamification.ts` | `/api/gamification/role`, `/resources/allocate`, `/tasks/orchestrate`, `/schedule/:id/dispatch`, `/exo/:id/feedback`, `/brain/suggestions` |

Server controllers confirm the same namespaces:

| Controller | Routes |
|------------|--------|
| `server/modules/dashboard/dashboard.controller.ts` | `api/dashboard/*` |
| `server/modules/spatial/spatial.controller.ts` | `api/spatial/*` |
| `server/modules/world/world.controller.ts` | `api/world/*` |
| `server/modules/scheduler/scheduler.controller.ts` | `api/scheduler/*` |
| `server/modules/gamification/gamification.controller.ts` | `api/gamification/*` |
| `server/modules/simulator/simulator.controller.ts` | `api/simulator/*` |
| `server/modules/ingest/ingest.controller.ts` | `api/ingest/*` |

Target API namespaces `organization`, `workstation`, `task`, `resource`,
`control`, `eventRule`, `model`, `knowledge`, `notification`, `system` are not
implemented as client namespaces.

## 5. Current Query Keys

No `queryKeys.ts` exists. Current keys (not centralized):

- `overview`, `events-recent`, `devices` (+ search object), `event-stats`,
  `workers`
- `spatial-entities`, `spatial-entities-all`, `spatial-entities`/`person`,
  `spatial-hierarchy`
- `world-state`, `replay-snapshots`
- `events` (+ status), `events-center` (+ status), `alert-toast-l3`
- `schedule-plans` (+ status), `schedule-audits`
- `brain-suggestions`, `workbench-overview`, `workbench-events-open`,
  `workbench-plans-proposed`
- `device-bindings` (+ device id)
- Business UI: `userProfileQueries`, `departmentQueries`, `userQueries`,
  `chatQueries`

## 6. Deploy Files

| File | Content |
|------|---------|
| `deploy/docker-compose.yml` | 7 services: edge-gateway, ewoh-api, ewoh-adapter, ewoh-inference, postgres, redis, ewoh-logs; networks `ewoh-internal`, `ewoh-edge`; volumes `ewoh-pgdata`, `ewoh-redis-data` |
| `deploy/.env.example` | EWOH_* runtime variables (host/port/db/adapters/retention/log/auth/TLS/export roles) |
| `docs/deployment/README.md` | Four-zone topology, process run, compose run, production checklist, health/backup/recovery skeleton |
| `docs/operations/README.md` | Daily inspection, four-level monitoring, alerting/restore/emergency placeholders |

Missing deploy files: `Dockerfile`, `nginx.conf`, `certs/`. Compose references
them, so `docker compose up` is not production-ready as checked.

## 7. CI Workflows

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `.github/workflows/test.yml` | push, pull_request | Python unittest, ruff, zero-dependency guard |
| `.github/workflows/package.yml` | tag `v*` | Source tarball + artifact upload (30d retention) |
| `.github/workflows/security.yml` | push, pull_request | bandit, mechanical safety-symbol guard |

No CI exists for the `ewoh-spark-app` NestJS/React app: no client build, no Jest
run, no eslint/stylelint/type:check, no frontend artifact.

## 8. Scripts Inventory

Python (`Makefile`): `run`, `run-stub`, `demo`, `test`, `test-contract`,
`lint`, `lint-fix`, `security`, `format`, `clean`.

Frontend/NestJS (`ewoh-spark-app/package.json`): `dev`, `dev:server`,
`dev:client`, `build`, `build:prod`, `build:server`, `build:client`, `start`,
`test`, `test:e2e`, `eslint`, `stylelint`, `type:check`, `lint`, `format`,
`precommit`.

## 9. Gaps Against Authoritative UI / DevOps Contracts

UI gaps:

- Only 5 app routes; 11 center routes missing.
- Layout has no situation/management/decision/foundation role grouping.
- No role filtering, permission denied state, or stale state.
- Command Map has 9 modes but not the target four operation modes; L3/L4 absent.
- No interaction grammar for click/double-click/box-select/drag/action menu.
- No WebGL2/GPU detection or manual 2D/3D fallback toggle.
- API namespaces and `queryKeys.ts` not implemented.
- Current cards use `rounded-xl` (12px), above the 8px card-radius constraint;
  pages are heavily blue/white/slate and use gradient hero content, which
  conflicts with the design constraints in `ui-contract.md`.

DevOps gaps:

- Dockerfile, nginx.conf, and certs absent; compose is placeholder-level.
- Compose describes the Python service, not the documented NestJS/React/PostgreSQL stack.
- No healthchecks, backup job, monitoring scrape target, or alerting.
- No deploy/release workflow, no migration/rollback CI, no release manifest.
- CI only covers the Python package; `ewoh-spark-app` has no CI.
- SLO/RPO/RTO performance and recovery targets are unverified.

## 10. Verification Notes

`confirmed_current`: all file paths in this report were inspected in the
worktree on 2026-08-03.

`stale_or_unverified`:

- Runtime behavior of pages, polling, 3D rendering, and build scripts was not
  executed in this pass.
- `Dockerfile`, `nginx.conf`, and `certs` were confirmed absent by `ls`, not by
  container launch.
- All plan targets (routes, roles, states, SLOs, migration gates) are
  authoritative-plan-derived and not implementation-verified.
