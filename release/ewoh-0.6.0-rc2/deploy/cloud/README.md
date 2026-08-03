# EWOH Cloud Deployment

This directory contains the standalone cloud deployment for EWOH. Miaoda is
not used at runtime.

## Single VM / Docker Compose

```bash
cp .env.example .env
docker compose -f deploy/cloud/docker-compose.standalone.yml up -d
```

The API image serves both the REST API and the built React client. Health
check: `GET /health`.

## Managed Cloud

- Use managed PostgreSQL 17 and Redis 7.
- Set `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGINS`,
  `PUBLIC_BASE_URL`.
- Run migrations with `db/runner/run_migrations.js`.
- Scale the `api` service horizontally behind a load balancer.

## Release Drill

Before production, run the full release drill against a disposable database:

```bash
EWOH_DATABASE_URL='postgresql://owner:...@host:5432/ewoh_drill' \
EWOH_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh_drill' \
EWOH_API_DATABASE_PASSWORD='<runtime password>' \
EWOH_BOOTSTRAP_ADMIN_USERNAME='drill_admin' \
EWOH_BOOTSTRAP_ADMIN_PASSWORD='<12+ chars>' \
bash scripts/release-drill.sh
```

The drill applies the standalone schema, verifies RLS/audit, destroys and
rebuilds the schema, runs the security probe, then runs Jest, OpenAPI strict
audit, HTTP+PostgreSQL E2E, production build, and DDL hygiene checks.

## High Availability

- Stateless API replicas.
- Managed PostgreSQL with backups and multi-AZ.
- Redis for cache/rate/idempotency.
- Health checks and rolling updates.
- S3-compatible object storage for 3D assets and evidence; configure
  `OBJECT_STORAGE_ENDPOINT` and `OBJECT_STORAGE_BUCKET` to enable it, otherwise
  the API falls back to `UPLOAD_DIR` on the local disk/volume.
- TLS is terminated at the edge gateway/load balancer. The shipped
  `k8s/ingress.yaml` intentionally routes HTTP to the cluster; if the ingress
  itself terminates TLS, add the `tls` block and certificate secret there.

## Kubernetes

Kubernetes manifests are the next milestone; the compose file is the
single-node cloud baseline.
