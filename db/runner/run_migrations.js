#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..', '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

const FILES = {
  migration: path.join(root, 'db/migrations/001_ewoh_managed_tables.sql'),
  rollback: path.join(root, 'db/migrations/001_ewoh_managed_tables.rollback.sql'),
  verify: path.join(root, 'db/verify/001_verify.sql'),
  seed: path.join(root, 'db/seed/001_demo_seed.sql'),
  users: path.join(root, 'db/migrations/002_ewoh_users.sql'),
  users_rollback: path.join(root, 'db/migrations/002_ewoh_users.rollback.sql'),
  users_seed: path.join(root, 'db/seed/002_default_admin.sql'),
  standalone: path.join(root, 'db/migrations/standalone_001_schema.sql'),
  standalone_rollback: path.join(root, 'db/migrations/standalone_001_schema.rollback.sql'),
  standalone_verify: path.join(root, 'db/verify/standalone_001_verify.sql'),
  standalone_seed: path.join(root, 'db/seed/standalone_001_seed.sql'),
  standalone_users: path.join(root, 'db/migrations/standalone_002_users.sql'),
  standalone_users_rollback: path.join(root, 'db/migrations/standalone_002_users.rollback.sql'),
  standalone_runtime_role: path.join(root, 'db/migrations/standalone_003_runtime_role.sql'),
  standalone_runtime_role_rollback: path.join(root, 'db/migrations/standalone_003_runtime_role.rollback.sql'),
  standalone_domain: path.join(root, 'db/migrations/standalone_004_ewoh_domain.sql'),
  standalone_domain_rollback: path.join(root, 'db/migrations/standalone_004_ewoh_domain.rollback.sql'),
  standalone_domain_verify: path.join(root, 'db/verify/standalone_004_verify.sql'),
  standalone_admin: path.join(root, 'db/seed/standalone_002_admin.sql'),
  standalone_workbench_prod: path.join(root, 'db/migrations/standalone_005_workbench_prod.sql'),
  standalone_workbench_prod_rollback: path.join(root, 'db/migrations/standalone_005_workbench_prod.rollback.sql'),
  standalone_workbench_prod_verify: path.join(root, 'db/verify/standalone_005_verify.sql'),
  standalone_scheduling: path.join(root, 'db/migrations/standalone_006_scheduling.sql'),
  standalone_scheduling_rollback: path.join(root, 'db/migrations/standalone_006_scheduling.rollback.sql'),
  standalone_scheduling_verify: path.join(root, 'db/verify/standalone_006_verify.sql'),
  standalone_scheduling_seed: path.join(root, 'db/seed/standalone_006_scheduling_seed.sql'),
  standalone_reservation_conflict: path.join(root, 'db/migrations/standalone_009_reservation_conflict.sql'),
  standalone_reservation_conflict_rollback: path.join(root, 'db/migrations/standalone_009_reservation_conflict.rollback.sql'),
  standalone_reservation_conflict_verify: path.join(root, 'db/verify/standalone_009_verify.sql'),
  standalone_scheduling_feedback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.sql'),
  standalone_scheduling_feedback_rollback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.rollback.sql'),
  standalone_scheduling_feedback_verify: path.join(root, 'db/verify/standalone_010_verify.sql'),
};

const PLAN_NAMES = Object.freeze(Object.keys(FILES));
const ROLLBACK_COMMANDS = new Set([
  '--rollback',
  '--rollback-users',
  '--rollback-standalone',
  '--rollback-standalone-users',
  '--rollback-standalone-runtime-role',
  '--rollback-standalone-domain',
  '--rollback-standalone-workbench-prod',
  '--rollback-standalone-scheduling',
  '--rollback-standalone-reservation-conflict',
  '--rollback-standalone-scheduling-feedback',
]);
const EXECUTE_COMMANDS = new Set([
  '--apply',
  '--rollback',
  '--verify',
  '--seed',
  '--apply-users',
  '--rollback-users',
  '--seed-users',
  '--apply-standalone',
  '--rollback-standalone',
  '--verify-standalone',
  '--seed-standalone',
  '--apply-standalone-users',
  '--rollback-standalone-users',
  '--apply-standalone-runtime-role',
  '--rollback-standalone-runtime-role',
  '--seed-standalone-admin',
  '--apply-standalone-domain',
  '--rollback-standalone-domain',
  '--verify-standalone-domain',
  '--apply-standalone-workbench-prod',
  '--rollback-standalone-workbench-prod',
  '--verify-standalone-workbench-prod',
  '--apply-standalone-scheduling',
  '--rollback-standalone-scheduling',
  '--verify-standalone-scheduling',
  '--seed-standalone-scheduling',
  '--apply-standalone-reservation-conflict',
  '--rollback-standalone-reservation-conflict',
  '--verify-standalone-reservation-conflict',
  '--apply-standalone-scheduling-feedback',
  '--rollback-standalone-scheduling-feedback',
  '--verify-standalone-scheduling-feedback',
]);

const TOKEN = '__EWOH_SCHEMA__';
const DEFAULT_SCHEMA = 'workspace_aadknm4yzbyds';

function loadEnv() {
  try {
    const dotenv = requireFromApp('dotenv');
    for (const name of ['.env.local', '.env']) {
      const file = path.join(appDir, name);
      if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
    }
  } catch (err) {
    // Plan mode does not need project env loading.
  }
}

function schemaName() {
  return process.env.EWOH_SCHEMA || DEFAULT_SCHEMA;
}

function validateSchema(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid EWOH_SCHEMA: ${value}`);
  }
  return value;
}

function substitute(sqlText, schema) {
  return sqlText.split(TOKEN).join(schema);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** Batch 8 G5：从 schema-manifest.yaml（单一事实源）派生 F61-02 域表数量。
 * 消除 verify 期望值硬编码（原固定 6），manifest 变更时 verify 自动跟随。
 * js-yaml 经 createRequire 从应用依赖加载；解析失败回退硬编码值并告警。 */
function domainTableCountFromManifest() {
  try {
    const yaml = requireFromApp('js-yaml');
    const manifestPath = path.join(root, 'db/contracts/schema-manifest.yaml');
    const doc = yaml.load(read(manifestPath));
    const tables = Array.isArray(doc && doc.managed_tables) ? doc.managed_tables : [];
    // F61-02 域表：capability_mapping 含 domain 能力 或 domain=Scale 的 6 张持久化表。
    // 与 standalone_004_verify.sql 的 6 张表（resource_locks/handoffs/git_sync_state/
    // evidence_metadata/factory_replication_sessions/idempotency_keys）对应。
    const domainTables = tables.filter(
      (t) =>
        t &&
        Array.isArray(t.capability_mapping) &&
        t.capability_mapping.some((c) => String(c).startsWith('scale.') || String(c) === 'domain.persistence'),
    );
    // 兜底：若 manifest 无显式 domain 标记，按 004 迁移的 6 张表白名单精确匹配。
    const knownDomainTables = [
      'ewoh_resource_locks', 'ewoh_handoffs', 'ewoh_git_sync_state',
      'ewoh_evidence_metadata', 'ewoh_factory_replication_sessions', 'ewoh_idempotency_keys',
    ];
    const matched = tables.filter((t) => t && knownDomainTables.includes(t.physical_table));
    const expected = matched.length > 0 ? matched.length : domainTables.length;
    if (expected > 0) return expected;
    console.warn('[verify] schema-manifest 未找到 F61-02 域表条目，回退硬编码 6');
    return 6;
  } catch (e) {
    console.warn(`[verify] 解析 schema-manifest 失败（${e.message}），回退硬编码 6`);
    return 6;
  }
}

function renderAdminSeed(sqlText) {
  const username = process.env.EWOH_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.EWOH_BOOTSTRAP_ADMIN_PASSWORD;
  const displayName = process.env.EWOH_BOOTSTRAP_ADMIN_DISPLAY_NAME || username;
  if (!username || !/^[A-Za-z0-9_.@-]{3,128}$/.test(username)) {
    throw new Error('EWOH_BOOTSTRAP_ADMIN_USERNAME must be 3-128 safe characters');
  }
  if (!password || password.length < 12) {
    throw new Error('EWOH_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  }
  const bcrypt = requireFromApp('bcryptjs');
  const passwordHash = bcrypt.hashSync(password, 12);
  const escapeLiteral = (value) => String(value).replace(/'/g, "''");
  return sqlText
    .split('__EWOH_ADMIN_USERNAME__').join(escapeLiteral(username))
    .split('__EWOH_ADMIN_PASSWORD_HASH__').join(escapeLiteral(passwordHash))
    .split('__EWOH_ADMIN_DISPLAY_NAME__').join(escapeLiteral(displayName));
}

function renderRuntimeRole(sqlText) {
  const password = process.env.EWOH_API_DATABASE_PASSWORD;
  if (!password || password.length < 16) {
    throw new Error('EWOH_API_DATABASE_PASSWORD must be at least 16 characters');
  }
  const escapedPassword = password.replace(/'/g, "''");
  return sqlText.split('__EWOH_API_DATABASE_PASSWORD__').join(escapedPassword);
}

function usage() {
  console.error(`Usage: run_migrations.js --plan [${PLAN_NAMES.join('|')}]`);
  console.error('       run_migrations.js --apply | --rollback | --verify | --seed');
  console.error('       run_migrations.js --apply-users | --rollback-users | --seed-users');
  console.error('       run_migrations.js --apply-standalone | --rollback-standalone | --verify-standalone | --seed-standalone');
  console.error('       run_migrations.js --apply-standalone-users | --rollback-standalone-users | --seed-standalone-admin');
  console.error('       run_migrations.js --apply-standalone-runtime-role | --rollback-standalone-runtime-role');
  console.error('       run_migrations.js --apply-standalone-domain | --rollback-standalone-domain | --verify-standalone-domain');
  console.error('       run_migrations.js --apply-standalone-workbench-prod | --rollback-standalone-workbench-prod | --verify-standalone-workbench-prod');
  console.error('       run_migrations.js --apply-standalone-scheduling | --rollback-standalone-scheduling | --verify-standalone-scheduling | --seed-standalone-scheduling');
  console.error('       run_migrations.js --apply-standalone-reservation-conflict | --rollback-standalone-reservation-conflict | --verify-standalone-reservation-conflict');
  console.error('       run_migrations.js --apply-standalone-scheduling-feedback | --rollback-standalone-scheduling-feedback | --verify-standalone-scheduling-feedback');
  console.error('Env: EWOH_DATABASE_URL or SUDA_DATABASE_URL, EWOH_SCHEMA, EWOH_ALLOW_DDL=1');
  console.error('Rollback also requires EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1.');
  process.exit(2);
}

function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) usage();

  const fileArg = args.find((a) => PLAN_NAMES.includes(a));

  if (command === '--plan') {
    const which = fileArg || 'migration';
    const schema = validateSchema(which.startsWith('standalone') ? 'public' : schemaName());
    const sql = substitute(read(FILES[which]), schema);
    process.stdout.write(`-- EWOH DDL plan: ${which} | schema: ${schema}\n`);
    process.stdout.write(sql.endsWith('\n') ? sql : `${sql}\n`);
    return;
  }

  if (!EXECUTE_COMMANDS.has(command)) usage();

  const isStandalone = command.includes('standalone');
  const schema = validateSchema(isStandalone ? 'public' : schemaName());

  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  if (!url) {
    console.error('EWOH_DATABASE_URL or SUDA_DATABASE_URL is required.');
    process.exit(2);
  }
  if (!['--verify', '--verify-standalone', '--verify-standalone-domain', '--verify-standalone-workbench-prod'].includes(command) && process.env.EWOH_ALLOW_DDL !== '1') {
    console.error('EWOH_ALLOW_DDL=1 is required for --apply and --rollback.');
    process.exit(2);
  }
  if (ROLLBACK_COMMANDS.has(command) && process.env.EWOH_ALLOW_DESTRUCTIVE_ROLLBACK !== '1') {
    console.error('EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1 is required for destructive rollback.');
    process.exit(2);
  }

  const postgres = requireFromApp('postgres');
  const sql = postgres(url, {
    max: 1,
    onnotice: process.env.EWOH_SHOW_NOTICES === '1' ? undefined : () => {},
  });

  (async () => {
    if (command === '--verify-standalone-domain') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_domain_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const count = Number(row.ewoh_domain_table_count || 0);
      // Batch 8 G5：期望值从 schema-manifest.yaml（单一事实源）派生，消除硬编码 6。
      const expected = domainTableCountFromManifest();
      if (count !== expected) {
        console.error(`VERIFY FAILED: expected ewoh_domain_table_count=${expected}, got ${count}`);
        process.exitCode = 1;
      } else {
        console.log(`VERIFY OK: all ${expected} F61-02 domain tables present`);
      }
      return;
    }

    if (command === '--verify-standalone-workbench-prod') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_workbench_prod_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const tableCount = Number(row.ewoh_workbench_persist_table_count || 0);
      const orgColumns = Number(row.workbench_org_columns || 0);
      const defaultUq = Number(row.saved_views_default_uq || 0);
      if (tableCount !== 2 || orgColumns !== 6 || defaultUq !== 1) {
        console.error(`VERIFY FAILED: expected (2,6,1), got (${tableCount},${orgColumns},${defaultUq})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: workbench persistence tables + org_id columns + default-view unique index present');
      }
      return;
    }

    if (command === '--verify-standalone-reservation-conflict') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_reservation_conflict_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const guard = Number(row.reservation_no_overlap_guard || 0);
      if (guard !== 1) {
        console.error(`VERIFY FAILED: expected reservation_no_overlap_guard=1, got ${guard}`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: reservation no-overlap exclusion constraint present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling-feedback') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_feedback_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.ewoh_scheduling_feedback_columns || 0);
      const indexes = Number(row.ewoh_scheduling_feedback_indexes || 0);
      if (columns !== 16 || indexes !== 4) {
        console.error(`VERIFY FAILED: expected (16,4), got (${columns},${indexes})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling feedback table + indexes present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const tableCount = Number(row.ewoh_scheduling_table_count || 0);
      const v2Columns = Number(row.ewoh_schedule_plan_v2_columns || 0);
      const versionCol = Number(row.ewoh_schedule_plan_version_col || 0);
      if (tableCount !== 7 || v2Columns !== 7 || versionCol !== 1) {
        console.error(`VERIFY FAILED: expected (7,7,1), got (${tableCount},${v2Columns},${versionCol})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling V2 tables + ewoh_schedule_plan V2 columns present');
      }
      return;
    }

    if (['--verify', '--verify-standalone'].includes(command)) {
      const verifyFile = command === '--verify-standalone' ? FILES.standalone_verify : FILES.verify;
      const rows = await sql.unsafe(substitute(read(verifyFile), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const expected = {
        managed_table_count: 51,
        rls_enabled: 51,
        audit_seq_identity: 1,
        world_delta_seq_identity: 1,
        audit_function_count: 1,
        scheduler_config_org_key: 1,
      };
      const bad = Object.entries(row)
        .filter(([key, value]) => Number(value) !== (expected[key] || 0))
        .map(([key, value]) => `${key}=${value}`);
      if (bad.length) {
        console.error(`VERIFY FAILED: ${bad.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK');
      }
      return;
    }

    const which = {
      '--apply': 'migration',
      '--rollback': 'rollback',
      '--apply-users': 'users',
      '--rollback-users': 'users_rollback',
      '--seed': 'seed',
      '--seed-users': 'users_seed',
      '--apply-standalone': 'standalone',
      '--rollback-standalone': 'standalone_rollback',
      '--seed-standalone': 'standalone_seed',
      '--apply-standalone-users': 'standalone_users',
      '--rollback-standalone-users': 'standalone_users_rollback',
      '--apply-standalone-runtime-role': 'standalone_runtime_role',
      '--rollback-standalone-runtime-role': 'standalone_runtime_role_rollback',
      '--apply-standalone-domain': 'standalone_domain',
      '--rollback-standalone-domain': 'standalone_domain_rollback',
      '--apply-standalone-workbench-prod': 'standalone_workbench_prod',
      '--rollback-standalone-workbench-prod': 'standalone_workbench_prod_rollback',
      '--apply-standalone-scheduling': 'standalone_scheduling',
      '--rollback-standalone-scheduling': 'standalone_scheduling_rollback',
      '--seed-standalone-admin': 'standalone_admin',
      '--seed-standalone-scheduling': 'standalone_scheduling_seed',
      '--apply-standalone-reservation-conflict': 'standalone_reservation_conflict',
      '--rollback-standalone-reservation-conflict': 'standalone_reservation_conflict_rollback',
      '--apply-standalone-scheduling-feedback': 'standalone_scheduling_feedback',
      '--rollback-standalone-scheduling-feedback': 'standalone_scheduling_feedback_rollback',
    }[command];
    let sqlText = substitute(read(FILES[which]), schema);
    if (['--seed-users', '--seed-standalone-admin'].includes(command)) {
      sqlText = renderAdminSeed(sqlText);
    }
    if (command === '--apply-standalone-runtime-role') {
      sqlText = renderRuntimeRole(sqlText);
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
    });
    console.log(`${command} completed for schema ${schema}`);
  })().catch((err) => {
    console.error('ERROR', err && (err.message || err));
    process.exitCode = 1;
  }).finally(async () => {
    try {
      await sql.end();
    } catch (err) {
      // Ignore close errors.
    }
  });
}

main();
