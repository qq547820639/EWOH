#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

: "${EWOH_OPS_SOURCE_URL:?EWOH_OPS_SOURCE_URL is required}"
: "${EWOH_OPS_RESTORE_ADMIN_URL:?EWOH_OPS_RESTORE_ADMIN_URL is required}"
: "${EWOH_OPS_RESTORE_DB:?EWOH_OPS_RESTORE_DB is required}"

export EWOH_OPS_RESTORE_ADMIN_URL
export EWOH_OPS_RESTORE_DB

# SCR-002: EWOH_OPS_RESTORE_DB 会被拼入 DDL（drop/create database），必须是安全标识符。
# 白名单：字母开头，仅字母/数字/下划线，长度 <= 63（PostgreSQL NAMEDATALEN-1）。
if ! printf '%s' "$EWOH_OPS_RESTORE_DB" | grep -Eq '^[A-Za-z][A-Za-z0-9_]{0,62}$'; then
  echo "FATAL: EWOH_OPS_RESTORE_DB 含非法字符（仅允许字母/数字/下划线，字母开头，<=63 字符）: $EWOH_OPS_RESTORE_DB" >&2
  exit 1
fi

RESTORE_URL="$(
  node --input-type=module -e "
    const url = new URL(process.env.EWOH_OPS_RESTORE_ADMIN_URL);
    url.pathname = '/' + encodeURIComponent(process.env.EWOH_OPS_RESTORE_DB);
    console.log(url.toString());
  "
)"
export RESTORE_URL

echo "== create disposable restore database =="
node --input-type=module -e "
  import postgres from './ewoh-spark-app/node_modules/postgres/src/index.js';
  const sql = postgres(process.env.EWOH_OPS_RESTORE_ADMIN_URL, { max: 1 });
  const db = process.env.EWOH_OPS_RESTORE_DB;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(db)) {
    throw new Error('EWOH_OPS_RESTORE_DB is not a safe database identifier: ' + db);
  }
  await sql.unsafe('drop database if exists \"' + db + '\"');
  await sql.unsafe('create database \"' + db + '\"');
  await sql.end();
  console.log('restore database ready: ' + db);
"

echo "== apply schema to restore database =="
EWOH_DATABASE_URL="$RESTORE_URL" EWOH_ALLOW_DDL=1 \
  node db/runner/run_migrations.js --apply-standalone
EWOH_DATABASE_URL="$RESTORE_URL" EWOH_ALLOW_DDL=1 \
  node db/runner/run_migrations.js --apply-standalone-users

echo "== logical backup source =="
BACKUP_FILE="$(mktemp -t ewoh-ops-backup-XXXX.json)"
node scripts/postgres-logical-backup.mjs \
  --action backup --url "$EWOH_OPS_SOURCE_URL" --out "$BACKUP_FILE"

echo "== restore into disposable database =="
node scripts/postgres-logical-backup.mjs \
  --action restore --url "$RESTORE_URL" --in "$BACKUP_FILE"

echo "== verify restored counts =="
node scripts/postgres-logical-backup.mjs \
  --action verify --url "$RESTORE_URL" --in "$BACKUP_FILE"

echo "== post-restore identity sequence smoke =="
RESTORE_URL="$RESTORE_URL" node scripts/post-restore-smoke.mjs

echo "ALL STANDALONE OPS CHECKS PASSED"
