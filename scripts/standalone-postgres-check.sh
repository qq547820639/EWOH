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

# SCR-023: 专项迁移清单单一来源——后缀在此定义一次，apply 按序展开、
# rollback 由同一列表逆序派生（apply-standalone-<x> ↔ rollback-standalone-<x>）。
# 新增迁移只需在 STANDALONE_SUFFIXES 追加一项，不再手工同步回滚清单。
STANDALONE_SUFFIXES=(
  identity-mapping
  maintenance-quality
  work-order
  event-dedup
  agent-manifest
  agent-task
  knowledge-entry
  inference-result
  learning-evaluation
  trace-span
  dead-letter
  simulation-run
  learning-proposal
  exo-session
  outcome-annotation
  shadow-plan-isolation
  agent-approval
  decision-records
  exo-config
  agent-approval-decision
  learning-proposal-decision
  policy-activation-decision
  route-org-isolation
)

apply_and_verify() {
  echo "== apply standalone schema =="
  node db/runner/run_migrations.js --apply-standalone
  for s in "${STANDALONE_SUFFIXES[@]}"; do
    node db/runner/run_migrations.js "--apply-standalone-${s}"
  done
  node db/runner/run_migrations.js --verify-standalone
  node db/runner/run_migrations.js --seed-standalone
  node db/runner/run_migrations.js --apply-standalone-users
  node db/runner/run_migrations.js --seed-standalone-admin
  node db/runner/run_migrations.js --apply-standalone-runtime-role

  echo "== idempotent reapply =="
  node db/runner/run_migrations.js --apply-standalone
  for s in "${STANDALONE_SUFFIXES[@]}"; do
    node db/runner/run_migrations.js "--apply-standalone-${s}"
  done
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
# 专项迁移由独立 apply 创建，必须显式成对回滚（SCR-023：逆序派生自 STANDALONE_SUFFIXES）——
# 否则 base --rollback-standalone 之后仍有 EWOH 对象残留，破坏"回滚到 0 对象"断言。
for ((i=${#STANDALONE_SUFFIXES[@]}-1; i>=0; i--)); do
  node db/runner/run_migrations.js "--rollback-standalone-${STANDALONE_SUFFIXES[i]}"
done
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
