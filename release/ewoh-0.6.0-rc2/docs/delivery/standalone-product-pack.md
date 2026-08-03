# EWOH Standalone Cloud Product Pack

Status: validated v1.1 (2026-08-03)

## Runtime

- NestJS standalone bootstrap (no Miaoda PlatformModule)
- JWT login/refresh/me + RBAC + bcrypt user table
- PostgreSQL 17 via Drizzle/postgres-js
- Redis via ioredis with in-memory fallback
- Global API rate limit guard
- File service with local disk and S3-compatible object storage drivers

## Frontend

- React/Vite standalone build (`vite.standalone.config.ts`)
- Standard axios client, login page, token storage
- No Feishu CDN/Slardar/Tea in standalone HTML
- Served by the API image at `/`

## Database

- `db/migrations/standalone_001_schema.sql` (public schema, no user_profile)
- `db/verify/standalone_001_verify.sql`
- `db/seed/standalone_001_seed.sql`
- `db/migrations/standalone_002_users.sql`
- `db/seed/standalone_002_admin.sql`

## Deployment

- `deploy/cloud/Dockerfile.api`
- `deploy/cloud/docker-compose.standalone.yml`
- `deploy/cloud/k8s/` (Deployment, Service, Ingress, HPA, PDB)
- `.env.standalone.example`

## CI/CD

- `.github/workflows/standalone.yml`

## Evidence

- Jest: 137 tests / 39 suites
- HTTP + PostgreSQL E2E: 11/11 (auth, RBAC, refresh rotation/logout, org
  isolation, control/world/approval persistence, system config org scoping)
- OpenAPI strict audit: 106/106 controller operations documented
- One-click `scripts/standalone-check.sh`: passed with E2E and DDL hygiene
- `/health` 1000 req @ 50 concurrency: 6718 QPS, P95 14.63ms
- Browser regression: Playwright login/command-center/command-map/devices/alerts
- Approval persistence via `ewoh_event`/`ewoh_event_chain`/`ewoh_audit_log`

## Pending

- Container image build/apply in an environment with Docker/Kubernetes
- Production DDL/deploy and rollback drill (approval-gated)
- Production-grade load/HA verification
- Real device/gateway integration, monitoring, training, and user acceptance
