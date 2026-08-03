# EWOH File Storage

Status: adopted 2026-08-03

## Decision

The file service uses a pluggable storage driver so local development and
single-node deployment can run without external infrastructure, while managed
cloud deployments use S3-compatible object storage for 3D assets, evidence
files, and imports.

## Drivers

- Local disk: selected when `OBJECT_STORAGE_ENDPOINT` or
  `OBJECT_STORAGE_BUCKET` is empty. Content is written under `UPLOAD_DIR`
  (default `./data/uploads`).
- S3-compatible object storage: selected when both
  `OBJECT_STORAGE_ENDPOINT` and `OBJECT_STORAGE_BUCKET` are set. Works with S3,
  MinIO, Cloudflare R2, and compatible gateways via the AWS SDK v3 S3 client.

## Key Layout

Object storage keys are scoped under `OBJECT_STORAGE_PREFIX` (default `files`):

- `files/<uuid>`: raw file content
- `files/<uuid>.meta.json`: file metadata (name, content type, size, note,
  createdAt)

The metadata sidecar makes replicas stateless with respect to file state and
removes the need for a database table before live DDL is available.

## API

- `POST /api/files` multipart upload
- `GET /api/files` list
- `GET /api/files/:id` metadata
- `GET /api/files/:id/download` content download
- `DELETE /api/files/:id` delete

All `:id` values must be UUIDs; invalid values return 404 before storage access.

## Environment Contract

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPLOAD_DIR` | `./data/uploads` | Local driver root |
| `OBJECT_STORAGE_ENDPOINT` | empty | S3-compatible endpoint |
| `OBJECT_STORAGE_BUCKET` | empty | Bucket name |
| `OBJECT_STORAGE_REGION` | `auto` | Region for the S3 client |
| `OBJECT_STORAGE_ACCESS_KEY` | empty | Access key |
| `OBJECT_STORAGE_SECRET_KEY` | empty | Secret key |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | `true` | Path-style addressing for MinIO |
| `OBJECT_STORAGE_PREFIX` | `files` | Object key prefix |

## Operations

- Configure object storage in managed cloud deployments so API replicas do not
  share local disks.
- Docker Compose keeps a `ewoh-uploads` volume for the local fallback driver.
- Enable bucket versioning and retention when evidence files must be immutable.
- Monitor bucket access, quotas, and object count alongside API metrics.
