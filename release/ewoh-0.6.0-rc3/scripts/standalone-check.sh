#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/ewoh-spark-app"

echo "== type:check =="
npm run type:check

echo "== lint =="
npm run lint

echo "== jest =="
npm test -- --runInBand

echo "== client jest =="
npm run test:client

echo "== openapi strict audit =="
cd "$ROOT_DIR"
node tools/work-indexer/index.js --root "$ROOT_DIR" --output output/work-graph.json --strict
node tools/gate-engine/index.js --root "$ROOT_DIR" --output output/gate-decisions.json
node tools/resource-registry/index.js --root "$ROOT_DIR" --output output/resource-registry.json
node tools/handoff-service/index.js --root "$ROOT_DIR" --output output/handoffs.json
node tools/git-sync/index.js --root "$ROOT_DIR" --output output/git-sync.json
node tools/factory-replication/index.js --report tools/factory-replication/fixtures/passing.json --strict
node tools/factory-replication/site-readiness.js --report tools/factory-replication/fixtures/site-ready.json --strict
node scripts/audit-openapi-routes.js --strict
node scripts/audit-event-catalog.js
node scripts/audit-golden-factory.js
node scripts/audit-mapping-contracts.js
node scripts/audit-policy-contracts.js
node scripts/audit-workflow-contracts.js
node scripts/audit-work-graph-contracts.js
node scripts/audit-asset-catalog-contracts.js
node scripts/audit-factory-profile-contracts.js
node scripts/verify-helm-chart.js
node scripts/verify-deploy-artifacts.js
python3 scripts/rego-tck.py

echo "== e2e (requires runtime DB env) =="
if [[ -n "${EWOH_E2E_RUNTIME_DATABASE_URL:-}" ]]; then
  cd "$ROOT_DIR/ewoh-spark-app"
  npm run test:e2e
else
  echo "EWOH_E2E_RUNTIME_DATABASE_URL not set; skipping E2E"
fi

echo "== standalone build =="
cd "$ROOT_DIR/ewoh-spark-app"
npm run build:prod:standalone

cd "$ROOT_DIR"

echo "== DDL plans =="
node db/runner/run_migrations.js --plan > /tmp/ewoh-plan-migration.sql
node db/runner/run_migrations.js --plan seed > /tmp/ewoh-plan-seed.sql
node db/runner/run_migrations.js --plan users > /tmp/ewoh-plan-users.sql
node db/runner/run_migrations.js --plan users_rollback > /tmp/ewoh-plan-users-rollback.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone > /tmp/ewoh-plan-standalone.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_rollback > /tmp/ewoh-plan-standalone-rollback.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_seed > /tmp/ewoh-plan-standalone-seed.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_users > /tmp/ewoh-plan-standalone-users.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_users_rollback > /tmp/ewoh-plan-standalone-users-rollback.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_runtime_role > /tmp/ewoh-plan-standalone-runtime-role.sql
EWOH_SCHEMA=public node db/runner/run_migrations.js --plan standalone_runtime_role_rollback > /tmp/ewoh-plan-standalone-runtime-role-rollback.sql

echo "== standalone DDL hygiene =="
if grep -E 'user_profile|__EWOH_SCHEMA__|workspace_aadknm4yzbyds' /tmp/ewoh-plan-standalone.sql \
  | grep -v 'EWOH DDL plan' | grep -q .; then
  echo "ERROR: standalone DDL still contains Miaoda tokens"
  exit 1
fi

echo "ALL STANDALONE CHECKS PASSED"
