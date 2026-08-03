# EWOH Deployment Runbook

Status: validated v1.1 (2026-08-03)
Owner: AG-51

## Target Topology

Four zones are preserved:

- Device zone: exoskeleton controllers and local safety loops.
- Edge zone: adapters, protocol normalization, edge inference, buffering.
- Platform zone: NestJS API, Drizzle/PostgreSQL, world state, scheduler, AI,
  audit chain.
- Display zone: React command center and 2D/3D digital world.

## Prerequisites

- PostgreSQL 17 with a migration role that owns the target schema and can run
  DDL. The project dev role currently has USAGE but not CREATE.
- Node.js 22+, npm 10+, Python 3.11+ (runtime stdlib only).

## Database Install

```bash
EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --plan

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --apply

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
node db/runner/run_migrations.js --verify
```

Rollback:

```bash
EWOH_ALLOW_DDL=1 node db/runner/run_migrations.js --rollback
```

## Application Install

```bash
cd ewoh-spark-app
npm ci
EWOH_SKIP_PLUGIN_INIT=1 npm run build
npm start
```

The app serves at `http://localhost:3000/app/<appId>/`.

## Standalone Product Install

```bash
cd ewoh-spark-app
npm ci
npm run build:prod:standalone
EWOH_DEPLOY_TARGET=standalone \
DATABASE_URL='postgresql://ewoh_api:...@127.0.0.1:5432/ewoh' \
JWT_SECRET='<32+ chars>' \
PORT=3000 \
node dist/server/main.js
```

Standalone API serves at `http://127.0.0.1:3000`; login page, command center,
and command map are part of the same origin. Health checks:
`GET /health/live` and `GET /health/ready`.

Verified local smoke: `http://127.0.0.1:3200` with Playwright login and command
map rendering; `scripts/standalone-check.sh` passes end to end.

## Health Checks

- `GET /api/status` on the Python edge platform.
- NestJS app root returns 200.
- DDL verify query must return 48 managed tables, 48 RLS enabled, audit and
  world identity columns present, no direct authenticated DML.

## Operations

- Monitor API errors, RLS failures, world delta lag, device online status,
  audit chain continuity, and 3D load.
- Backup PostgreSQL before any migration.
- Keep rollback scripts in `db/migrations/`.
