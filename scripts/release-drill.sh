#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

: "${EWOH_DATABASE_URL:?EWOH_DATABASE_URL (owner, disposable DB) is required}"
: "${EWOH_RUNTIME_DATABASE_URL:?EWOH_RUNTIME_DATABASE_URL is required}"
: "${EWOH_API_DATABASE_PASSWORD:?EWOH_API_DATABASE_PASSWORD is required}"
: "${EWOH_BOOTSTRAP_ADMIN_USERNAME:?EWOH_BOOTSTRAP_ADMIN_USERNAME is required}"
: "${EWOH_BOOTSTRAP_ADMIN_PASSWORD:?EWOH_BOOTSTRAP_ADMIN_PASSWORD is required}"

export EWOH_ALLOW_DDL=1
export EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1
export EWOH_E2E_RUNTIME_DATABASE_URL="$EWOH_RUNTIME_DATABASE_URL"
if [[ -z "${EWOH_E2E_OWNER_DATABASE_URL:-}" ]]; then
  export EWOH_E2E_OWNER_DATABASE_URL="$EWOH_DATABASE_URL"
fi

echo "== Phase 1: PostgreSQL apply/verify/rollback/rebuild + security probe =="
bash scripts/standalone-postgres-check.sh

echo "== Phase 2: standalone check (tests, OpenAPI, E2E, build, DDL hygiene) =="
bash scripts/standalone-check.sh

echo "RELEASE DRILL PASSED"
