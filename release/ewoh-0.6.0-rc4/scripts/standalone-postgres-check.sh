#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

: "${EWOH_DATABASE_URL:?EWOH_DATABASE_URL is required}"
: "${EWOH_RUNTIME_DATABASE_URL:?EWOH_RUNTIME_DATABASE_URL is required}"
: "${EWOH_API_DATABASE_PASSWORD:?EWOH_API_DATABASE_PASSWORD is required}"
: "${EWOH_BOOTSTRAP_ADMIN_USERNAME:?EWOH_BOOTSTRAP_ADMIN_USERNAME is required}"
: "${EWOH_BOOTSTRAP_ADMIN_PASSWORD:?EWOH_BOOTSTRAP_ADMIN_PASSWORD is required}"

export EWOH_ALLOW_DDL=1
export EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1

echo "== generate standalone DDL =="
node scripts/generate-ddl-package.js
node scripts/generate-standalone-ddl.js

apply_and_verify() {
  echo "== apply standalone schema =="
  node db/runner/run_migrations.js --apply-standalone
  node db/runner/run_migrations.js --verify-standalone
  node db/runner/run_migrations.js --seed-standalone
  node db/runner/run_migrations.js --apply-standalone-users
  node db/runner/run_migrations.js --seed-standalone-admin
  node db/runner/run_migrations.js --apply-standalone-runtime-role

  echo "== idempotent reapply =="
  node db/runner/run_migrations.js --apply-standalone
  node db/runner/run_migrations.js --apply-standalone-users
  node db/runner/run_migrations.js --apply-standalone-runtime-role
  node db/runner/run_migrations.js --verify-standalone

  echo "== RLS, auth lookup, and audit chain =="
  node scripts/verify-standalone-security.js
}

apply_and_verify

echo "== destructive rollback =="
node db/runner/run_migrations.js --rollback-standalone-runtime-role
node db/runner/run_migrations.js --rollback-standalone-users
node db/runner/run_migrations.js --rollback-standalone

node --input-type=module - <<'NODE'
import postgres from './ewoh-spark-app/node_modules/postgres/src/index.js';

const sql = postgres(process.env.EWOH_DATABASE_URL, { max: 1 });
const [relations] = await sql`
  select count(*)::int as count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'ewoh_%'
    and c.relkind in ('r', 'p', 'S')
`;
const [functions] = await sql`
  select count(*)::int as count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'ewoh_%'
`;
await sql.end();

console.log(JSON.stringify({ relations: relations.count, functions: functions.count }));
if (relations.count !== 0 || functions.count !== 0) {
  throw new Error('standalone rollback left EWOH objects behind');
}
NODE

echo "== rebuild after rollback =="
apply_and_verify

echo "ALL POSTGRESQL 17 STANDALONE CHECKS PASSED"
