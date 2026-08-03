# API Contract (C2 v1.0)

Owner: AG-04
Status: C2 v1.0 frozen
Source: `openapi/ewoh.yaml`, `openapi/route-manifest.json`,
`ewoh-spark-app/shared/api.interface.ts`,
`ewoh-spark-app/server/modules/**/*.controller.ts`

## Freeze Evidence (2026-08-03)

Command:

```bash
node scripts/audit-openapi-routes.js --strict --json
```

Result:

- NestJS controller operations: 106
- OpenAPI operations: 106
- Documented controller operations: 106
- Undocumented: 0
- Specified but unimplemented: 0
- YAML parse: valid OpenAPI 3.0.3 via `js-yaml`

Evidence paths:

- `openapi/ewoh.yaml` (frozen contract, 93 paths / 106 operations)
- `openapi/route-manifest.json` (regenerated with the same audit command)

## General Rules

- All user access goes through NestJS API; no direct database access.
- Login required except explicit public endpoints: auth login/refresh/logout,
  health probes, and the rendered application root.
- Ingest endpoints use `X-Ingest-Key` instead of user Bearer auth.
- Org context per request; backend sets transaction GUCs.
- Unified error:
  `{"code":"ERROR_CODE","message":"human readable","details":{}}`
- Pagination uses `page/pageSize` (device search, audit offset/limit) or
  `cursor/limit` (world delta).
- Times are ISO 8601 with timezone; storage uses timestamptz.
- Lists never return sensitive health values or plaintext credentials.
- Idempotency: `POST /api/control/requests` requires `idempotencyKey`;
  duplicate submission returns the original request.

## Coverage Notes

- 106 operations are grouped under 20 tags: auth, world, devices,
  organization, spatial, tasks, resources, alerts, approvals, control, ai,
  audit, system, scheduler, gamification, ingest, simulator, files, health,
  and view.
- Request bodies and path/query parameters are derived from controller
  signatures, service DTOs, and `api.interface.ts`.
- Success responses use OpenAPI schemas where a DTO or mapped service return
  shape exists. JSON blob fields use `additionalProperties: true` when the
  controller/service intentionally stores dynamic payloads.
- Error responses reuse `components/responses` and `ErrorResponse`.

## Pending Human Confirmation

These schemas are intentionally conservative because the source layer stores
dynamic JSON or returns raw database rows:

- `DeviceBindingRecord` and `PersonnelBindingList`: raw `ewoh_device_binding`
  row shape is not mapped by a service DTO.
- `WorldEntity`, `evidenceJson`, `jointAngles`, `configValue`, `metricsJson`,
  `content`, and `HealthStatus.checks`: open objects with
  `additionalProperties: true`.
- `ExoskeletonFrameBatch` accepts either a bare array or `{ "frames": [...] }`,
  matching the controller's runtime handling.

## Critical Endpoints

| Area | Endpoint | Notes |
|------|----------|-------|
| Auth | POST `/api/auth/login`, `/api/auth/refresh`, GET `/api/auth/me` | public login/refresh/logout; Bearer for me |
| World | GET `/api/world/snapshot`, `/api/world/delta` | cursor/limit; 410 CURSOR_EXPIRED |
| Replay | GET `/api/world/replay?from&to&limit` | minute-level snapshots |
| Devices | GET `/api/devices`, `/api/dashboard/devices/search` | 19-dimension filters, page/pageSize |
| Bindings | GET/POST/DELETE `/api/dashboard/devices/:deviceId/bindings` | person/space/device binding |
| Tasks | GET/POST `/api/tasks`, POST `/api/tasks/:id/state` | production task lifecycle |
| Resources | POST `/api/resource/preorders`, issue/release | no oversell under per-resource lock |
| Alerts | GET `/api/alerts`, POST `/api/alerts/:id/state` | acknowledge/process/close/reopen |
| Approvals | POST `/api/approvals`, step/bypass/cancel | high-risk audit |
| Control | POST `/api/control/requests`, commands/receipts/revoke | idempotencyKey on create |
| AI | POST `/api/ai/suggestions`, `/api/ai/plans` | manual A2/A3 trigger only |
| Audit | GET `/api/audit` | read-only chain of custody |
| Scheduler | GET/POST `/api/scheduler/plans`, weights, confirm/dispatch | plan and weight lifecycle |
| Gamification | allocate/orchestrate/dispatch/feedback/brain suggestions | embodied factory game layer |
| Ingest | POST `/api/ingest/*` | machine-to-machine `X-Ingest-Key` |
| Files | POST/GET/DELETE `/api/files` | multipart upload and storage metadata |
| Spatial | GET `/api/spatial/*` | entities, topology, hierarchy |
| Simulator | GET status, POST start/stop | runtime status |
| System | GET/PUT `/api/system/config/:key` | org-scoped config |
| Health | GET `/health/live`, `/health/ready` | public probes |
| View | GET `/` | rendered application page |
