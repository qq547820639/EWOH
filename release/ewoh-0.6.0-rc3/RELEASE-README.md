# EWOH 0.6.0-rc3 Release Bundle

This bundle contains the standalone EWOH product source, database migrations,
deployment artifacts, contracts, Final 6 work orchestration tools/catalog,
and RC3 acceptance evidence.

## Build

```bash
cd ewoh-spark-app
npm ci
npm run build:prod:standalone
```

## Database

Run migrations against a disposable PostgreSQL 17 database first:

```bash
EWOH_DATABASE_URL='postgresql://owner:...@host:5432/ewoh' \
EWOH_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh' \
EWOH_API_DATABASE_PASSWORD='<runtime password>' \
EWOH_BOOTSTRAP_ADMIN_USERNAME='admin' \
EWOH_BOOTSTRAP_ADMIN_PASSWORD='<12+ chars>' \
bash scripts/release-drill.sh
```

## Run

```bash
cd ewoh-spark-app
EWOH_DEPLOY_TARGET=standalone \
DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh' \
JWT_SECRET='<32+ chars>' \
PORT=3000 \
node dist/server/main.js
```

See `docs/delivery/deployment-runbook.md` and `docs/delivery/release-manifest.yaml`.
