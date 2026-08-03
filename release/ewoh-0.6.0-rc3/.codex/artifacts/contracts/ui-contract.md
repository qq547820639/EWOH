# UI Contract (C5 v1.0)

Owner: AG-30
Status: C5 v1.0 frozen/validated (2026-08-03)
Source: `ewoh-spark-app/client/src/**`,
`ewoh-spark-app/shared/api.interface.ts`,
`.playwright-cli/page-*.yml`,
`.codex/artifacts/work/reviews/frontend-scenario-2026-08-03.md`,
`.codex/artifacts/work/evidence/round4.md`

## Routes and Roles

The app ships 11 center routes, a full-screen `/command-map`, `/login`,
`/403`, and 404. `/events` and `/workers` redirect to `/alerts` and
`/personnel`.

| Route | Center | Visible roles (UI nav) | Backend gate |
|-------|--------|------------------------|--------------|
| /command-center | Command center | global_admin, dispatcher, safety_admin | dashboard: those roles + device_ops |
| /digital-world | Digital world | dispatcher, workshop_lead | world/spatial: + global_admin |
| /scheduling | Scheduling | dispatcher, workshop_lead | scheduler: + global_admin |
| /ai-decision | AI decision | dispatcher, global_admin | ai: same |
| /devices | Devices | device_ops, dispatcher | dashboard: + global_admin/safety_admin |
| /personnel | Personnel/exo | workshop_lead, safety_admin | organization: + global_admin |
| /alerts | Risk/alerts | safety_admin, dispatcher | alert: + global_admin/workshop_lead |
| /organization | Organization/space | global_admin | organization: global_admin |
| /model-management | Model management | global_admin, device_ops | model: same |
| /data-assets | Data assets | global_admin | models + system config (global_admin) |
| /system | System | global_admin, safety_admin (UI) | system config: global_admin only |
| /command-map | Command map | all five roles | mixed module gates |

Known divergence: the UI shows `/system` to `safety_admin`, but every
`/api/system/config` call is backend-gated to `global_admin`; a safety_admin
who opens the route gets a 403 error state on the page. The route/role matrix
documents the UI as shipped and flags the API mismatch.

## Authentication and Session

- Login stores access token, refresh token, and `AuthUser` (roles, username,
  orgId) in local storage.
- `RequireAuth` redirects unauthenticated access to `/login` with return path;
  `RequireRole` renders the 403 page for roles missing from the route map.
- Layout filters nav groups by `getVisibleNavGroups(user.roles)`.
- `http.ts` has a single-flight 401 interceptor: refresh once, retry the
  original request once, clear session and redirect to `/login` on failure.
  Auth endpoints and retried requests never loop.
- Logout clears local tokens and navigates to `/login`. `POST
  /api/auth/logout` exists server-side and revokes the presented refresh jti,
  but the current Layout logout does not call it; remote revocation from the
  UI is a pending session-hygiene item.

## Global Data Layer

- `AppContainer` wraps the app in one `QueryClientProvider` (retry 1, stale
  10s, no window-focus refetch).
- Stable query keys exist in `hooks/queryKeys.ts`; CommandMap, Devices, Alerts,
  EventCenter, and AlertToast use React Query with refetch intervals.
- CommandMap polls entities 30s, world state 2s, overview 5s, replay 30s when
  not replaying; EventCenter polls events 5s; Devices polls 30s.
- Pending: several center pages (CommandCenter, DigitalWorld, Scheduling,
  AiDecision, Personnel, Organization, ModelManagement, DataAssets, System)
  still use single-shot `useEffect` fetches, so they do not yet satisfy the
  stale-data contract across the whole app.

## Command Map

- 9 modes: production, person, exoskeleton, body_load, safety_risk, device,
  environment, scheduling, data_quality. 2D and 3D both apply mode-specific
  coloring.
- Levels L0/L1 2D map, L2 3D twin, L3 workstation close-up, L4 person follow;
  keyboard toggles L0-L4.
- Real replay: `TimelinePanel` controls mode/speed/pause; `CommandMap` runs a
  playback loop through `advanceReplayTime`, projects the nearest snapshot via
  `snapshotToWorldState`, and 2D/3D render the projected world state instead
  of live data.
- Timeline event markers are clickable and select the event; alert toast
  "view detail" and "quick handle" focus the event and call
  `POST /api/dashboard/events/:eventId/handle`; EventCenter exposes
  acknowledge/handle mutations.
- 3D uses WebGL feature detection; when unavailable it renders the 2D L1 map
  with a "3D unavailable, switched to 2D" notice inside an error boundary.
- Pending: L3/L4 "related persons/devices" still render global `slice(0,8)`
  slices rather than focus-filtered relations; environment mode reads static
  entity metadata rather than the environment sensor API; scheduling mode uses
  a simplified person polyline.

## State Requirements

Every page implements loading and error states; empty states exist for list
pages. Permission denial is handled by the route guard/403 page. Pending:
DigitalWorld has no explicit empty state for its hierarchy tree, and stale-data
handling is not yet uniform across center pages (see Global Data Layer).

## Design Constraints

- Work-focused, dense, restrained UI; no marketing hero; 2D/2.5D first.
- Cards radius 0.5rem; no nested-card layout requirement violations found in
  current pages; icon-only controls use lucide and tooltips.
- Static basemap separated from dynamic entities in CommandMap.
- Light pages currently use one dominant blue-on-gray palette and CommandMap
  uses a separate dark theme; this is documented as a polish item, not a
  correctness defect.

## Browser Evidence

`.playwright-cli/page-*.yml` captures the login form, role-filtered nav as
rendered for `ui_smoke_admin`, command center KPI page, CommandMap (modes,
L0-L4, timeline tabs), devices center, and alerts center. `G7` in
`.codex/artifacts/gates.md` and `round4.md` record: login, command center,
command map, devices, alerts render with real data; no QueryClient failure and
no replay 500 after the fixes.
