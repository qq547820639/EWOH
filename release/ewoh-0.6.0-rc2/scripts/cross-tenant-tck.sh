#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

: "${EWOH_E2E_OWNER_DATABASE_URL:?EWOH_E2E_OWNER_DATABASE_URL is required}"
: "${EWOH_E2E_RUNTIME_DATABASE_URL:?EWOH_E2E_RUNTIME_DATABASE_URL is required}"

cd "$ROOT_DIR/ewoh-spark-app"
npm run test:e2e

echo "CROSS-TENANT TCK PASSED (HTTP + PostgreSQL org isolation E2E)"
