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
  standalone_scheduling_persistence: path.join(root, 'db/migrations/standalone_007_scheduling_persistence.sql'),
  standalone_scheduling_persistence_rollback: path.join(root, 'db/migrations/standalone_007_scheduling_persistence.rollback.sql'),
  standalone_phase2_realtime: path.join(root, 'db/migrations/standalone_008_phase2_realtime.sql'),
  standalone_phase2_realtime_rollback: path.join(root, 'db/migrations/standalone_008_phase2_realtime.rollback.sql'),
  standalone_scheduling_rollback: path.join(root, 'db/migrations/standalone_006_scheduling.rollback.sql'),
  standalone_scheduling_verify: path.join(root, 'db/verify/standalone_006_verify.sql'),
  standalone_scheduling_seed: path.join(root, 'db/seed/standalone_006_scheduling_seed.sql'),
  standalone_reservation_conflict: path.join(root, 'db/migrations/standalone_009_reservation_conflict.sql'),
  standalone_reservation_conflict_rollback: path.join(root, 'db/migrations/standalone_009_reservation_conflict.rollback.sql'),
  standalone_reservation_conflict_verify: path.join(root, 'db/verify/standalone_009_verify.sql'),
  standalone_scheduling_feedback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.sql'),
  standalone_scheduling_feedback_rollback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.rollback.sql'),
  standalone_scheduling_feedback_verify: path.join(root, 'db/verify/standalone_010_verify.sql'),
  standalone_outbox_sequence: path.join(root, 'db/migrations/standalone_011_outbox_sequence.sql'),
  standalone_outbox_sequence_rollback: path.join(root, 'db/migrations/standalone_011_outbox_sequence.rollback.sql'),
  standalone_outbox_sequence_verify: path.join(root, 'db/verify/standalone_011_verify.sql'),
  standalone_domain_columns: path.join(root, 'db/migrations/standalone_012_domain_columns.sql'),
  standalone_domain_columns_rollback: path.join(root, 'db/migrations/standalone_012_domain_columns.rollback.sql'),
  standalone_domain_columns_verify: path.join(root, 'db/verify/standalone_012_domain_columns.verify.sql'),
  standalone_route_cost_matrix: path.join(root, 'db/migrations/standalone_015_route_cost_matrix.sql'),
  standalone_route_cost_matrix_rollback: path.join(root, 'db/migrations/standalone_015_route_cost_matrix.rollback.sql'),
  standalone_route_cost_matrix_verify: path.join(root, 'db/verify/standalone_015_route_cost_matrix.verify.sql'),
  standalone_policy_weights: path.join(root, 'db/migrations/standalone_014_policy_weights.sql'),
  standalone_policy_weights_rollback: path.join(root, 'db/migrations/standalone_014_policy_weights.rollback.sql'),
  standalone_policy_weights_verify: path.join(root, 'db/verify/standalone_014_policy_weights.verify.sql'),
  standalone_conflict_lifecycle: path.join(root, 'db/migrations/standalone_013_conflict_lifecycle.sql'),
  standalone_conflict_lifecycle_rollback: path.join(root, 'db/migrations/standalone_013_conflict_lifecycle.rollback.sql'),
  standalone_conflict_lifecycle_verify: path.join(root, 'db/verify/standalone_013_conflict_lifecycle.verify.sql'),
  standalone_task_requirement: path.join(root, 'db/migrations/standalone_016_task_requirement.sql'),
  standalone_task_requirement_rollback: path.join(root, 'db/migrations/standalone_016_task_requirement.rollback.sql'),
  standalone_task_requirement_verify: path.join(root, 'db/verify/standalone_016_task_requirement.verify.sql'),
  standalone_scheduling_tables_fix: path.join(root, 'db/migrations/standalone_017_scheduling_tables_fix.sql'),
  standalone_scheduling_tables_fix_rollback: path.join(root, 'db/migrations/standalone_017_scheduling_tables_fix.rollback.sql'),
  standalone_scheduling_tables_fix_verify: path.join(root, 'db/verify/standalone_017_scheduling_tables_fix.verify.sql'),
  standalone_execution_feedback: path.join(root, 'db/migrations/standalone_018_execution_feedback.sql'),
  standalone_execution_feedback_rollback: path.join(root, 'db/migrations/standalone_018_execution_feedback.rollback.sql'),
  standalone_execution_feedback_verify: path.join(root, 'db/verify/standalone_018_execution_feedback.verify.sql'),
  standalone_kpi_replay: path.join(root, 'db/migrations/standalone_019_kpi_replay.sql'),
  standalone_kpi_replay_rollback: path.join(root, 'db/migrations/standalone_019_kpi_replay.rollback.sql'),
  standalone_kpi_replay_verify: path.join(root, 'db/verify/standalone_019_kpi_replay.verify.sql'),
  standalone_policy_lifecycle: path.join(root, 'db/migrations/standalone_020_policy_lifecycle.sql'),
  standalone_policy_lifecycle_rollback: path.join(root, 'db/migrations/standalone_020_policy_lifecycle.rollback.sql'),
  standalone_policy_lifecycle_verify: path.join(root, 'db/verify/standalone_020_policy_lifecycle.verify.sql'),
  standalone_sse_envelope: path.join(root, 'db/migrations/standalone_021_sse_envelope.sql'),
  standalone_sse_envelope_rollback: path.join(root, 'db/migrations/standalone_021_sse_envelope.rollback.sql'),
  standalone_sse_envelope_verify: path.join(root, 'db/verify/standalone_021_sse_envelope.verify.sql'),
  standalone_reservation_capacity: path.join(root, 'db/migrations/standalone_022_reservation_capacity.sql'),
  standalone_reservation_capacity_rollback: path.join(root, 'db/migrations/standalone_022_reservation_capacity.rollback.sql'),
  standalone_reservation_capacity_verify: path.join(root, 'db/verify/standalone_022_reservation_capacity.verify.sql'),
  standalone_scheduler_incremental: path.join(root, 'db/migrations/standalone_023_scheduler_incremental.sql'),
  standalone_scheduler_incremental_rollback: path.join(root, 'db/migrations/standalone_023_scheduler_incremental.rollback.sql'),
  standalone_scheduler_incremental_verify: path.join(root, 'db/verify/standalone_023_scheduler_incremental.verify.sql'),
  standalone_scheduler_outbox_notify: path.join(root, 'db/migrations/standalone_024_scheduler_outbox_notify.sql'),
  standalone_scheduler_outbox_notify_rollback: path.join(root, 'db/migrations/standalone_024_scheduler_outbox_notify.rollback.sql'),
  standalone_scheduler_outbox_notify_verify: path.join(root, 'db/verify/standalone_024_scheduler_outbox_notify.verify.sql'),
  standalone_scheduler_rls: path.join(root, 'db/migrations/standalone_025_scheduler_rls.sql'),
  standalone_scheduler_rls_rollback: path.join(root, 'db/migrations/standalone_025_scheduler_rls.rollback.sql'),
  standalone_scheduler_rls_verify: path.join(root, 'db/verify/standalone_025_scheduler_rls.verify.sql'),
  standalone_route_cost_matrix_full_key: path.join(root, 'db/migrations/standalone_026_route_cost_matrix_full_key.sql'),
  standalone_route_cost_matrix_full_key_rollback: path.join(root, 'db/migrations/standalone_026_route_cost_matrix_full_key.rollback.sql'),
  standalone_route_cost_matrix_full_key_verify: path.join(root, 'db/verify/standalone_026_route_cost_matrix_full_key.verify.sql'),
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
  '--rollback-standalone-outbox-sequence',
  '--rollback-standalone-domain-columns',
  '--rollback-standalone-route-cost-matrix',
  '--rollback-standalone-policy-weights',
  '--rollback-standalone-conflict-lifecycle',
  '--rollback-standalone-task-requirement',
  '--rollback-standalone-scheduling-tables-fix',
  '--rollback-standalone-execution-feedback',
  '--rollback-standalone-kpi-replay',
  '--rollback-standalone-policy-lifecycle',
  '--rollback-standalone-sse-envelope',
  '--rollback-standalone-reservation-capacity',
  '--rollback-standalone-scheduler-incremental',
  '--rollback-standalone-scheduler-outbox-notify',
  '--rollback-standalone-scheduler-rls',
  '--rollback-standalone-route-cost-matrix-full-key',
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
  '--apply-standalone-scheduling-persistence',
  '--rollback-standalone-scheduling-persistence',
  '--apply-standalone-phase2-realtime',
  '--rollback-standalone-phase2-realtime',
  '--apply-standalone-reservation-conflict',
  '--rollback-standalone-reservation-conflict',
  '--verify-standalone-reservation-conflict',
  '--apply-standalone-scheduling-feedback',
  '--rollback-standalone-scheduling-feedback',
  '--verify-standalone-scheduling-feedback',
  '--apply-standalone-outbox-sequence',
  '--rollback-standalone-outbox-sequence',
  '--verify-standalone-outbox-sequence',
  '--apply-standalone-domain-columns',
  '--rollback-standalone-domain-columns',
  '--verify-standalone-domain-columns',
  '--apply-standalone-route-cost-matrix',
  '--rollback-standalone-route-cost-matrix',
  '--verify-standalone-route-cost-matrix',
  '--apply-standalone-policy-weights',
  '--rollback-standalone-policy-weights',
  '--verify-standalone-policy-weights',
  '--apply-standalone-conflict-lifecycle',
  '--rollback-standalone-conflict-lifecycle',
  '--verify-standalone-conflict-lifecycle',
  '--apply-standalone-task-requirement',
  '--rollback-standalone-task-requirement',
  '--verify-standalone-task-requirement',
  '--apply-standalone-scheduling-tables-fix',
  '--rollback-standalone-scheduling-tables-fix',
  '--verify-standalone-scheduling-tables-fix',
  '--apply-standalone-execution-feedback',
  '--rollback-standalone-execution-feedback',
  '--verify-standalone-execution-feedback',
  '--apply-standalone-kpi-replay',
  '--rollback-standalone-kpi-replay',
  '--verify-standalone-kpi-replay',
  '--apply-standalone-policy-lifecycle',
  '--rollback-standalone-policy-lifecycle',
  '--verify-standalone-policy-lifecycle',
  '--apply-standalone-sse-envelope',
  '--rollback-standalone-sse-envelope',
  '--verify-standalone-sse-envelope',
  '--apply-standalone-reservation-capacity',
  '--rollback-standalone-reservation-capacity',
  '--verify-standalone-reservation-capacity',
  '--apply-standalone-scheduler-incremental',
  '--rollback-standalone-scheduler-incremental',
  '--verify-standalone-scheduler-incremental',
  '--apply-standalone-scheduler-outbox-notify',
  '--rollback-standalone-scheduler-outbox-notify',
  '--verify-standalone-scheduler-outbox-notify',
  '--apply-standalone-scheduler-rls',
  '--rollback-standalone-scheduler-rls',
  '--verify-standalone-scheduler-rls',
  '--apply-standalone-route-cost-matrix-full-key',
  '--rollback-standalone-route-cost-matrix-full-key',
  '--verify-standalone-route-cost-matrix-full-key',
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
  console.error('       run_migrations.js --apply-standalone-outbox-sequence | --rollback-standalone-outbox-sequence | --verify-standalone-outbox-sequence');
  console.error('       run_migrations.js --apply-standalone-domain-columns | --rollback-standalone-domain-columns | --verify-standalone-domain-columns');
  console.error('       run_migrations.js --apply-standalone-route-cost-matrix | --rollback-standalone-route-cost-matrix | --verify-standalone-route-cost-matrix');
  console.error('       run_migrations.js --apply-standalone-policy-weights | --rollback-standalone-policy-weights | --verify-standalone-policy-weights');
  console.error('       run_migrations.js --apply-standalone-conflict-lifecycle | --rollback-standalone-conflict-lifecycle | --verify-standalone-conflict-lifecycle');
  console.error('       run_migrations.js --apply-standalone-task-requirement | --rollback-standalone-task-requirement | --verify-standalone-task-requirement');
  console.error('       run_migrations.js --apply-standalone-reservation-capacity | --rollback-standalone-reservation-capacity | --verify-standalone-reservation-capacity');
  console.error('       run_migrations.js --apply-standalone-scheduler-incremental | --rollback-standalone-scheduler-incremental | --verify-standalone-scheduler-incremental');
  console.error('       run_migrations.js --apply-standalone-scheduler-outbox-notify | --rollback-standalone-scheduler-outbox-notify | --verify-standalone-scheduler-outbox-notify');
  console.error('       run_migrations.js --apply-standalone-scheduler-rls | --rollback-standalone-scheduler-rls | --verify-standalone-scheduler-rls');
  console.error('       run_migrations.js --apply-standalone-route-cost-matrix-full-key | --rollback-standalone-route-cost-matrix-full-key | --verify-standalone-route-cost-matrix-full-key');
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
  if (!['--verify', '--verify-standalone', '--verify-standalone-domain', '--verify-standalone-workbench-prod', '--verify-standalone-outbox-sequence', '--verify-standalone-domain-columns', '--verify-standalone-route-cost-matrix', '--verify-standalone-policy-weights', '--verify-standalone-conflict-lifecycle', '--verify-standalone-task-requirement', '--verify-standalone-scheduling-tables-fix', '--verify-standalone-execution-feedback', '--verify-standalone-kpi-replay', '--verify-standalone-policy-lifecycle', '--verify-standalone-sse-envelope', '--verify-standalone-reservation-capacity', '--verify-standalone-scheduler-incremental', '--verify-standalone-scheduler-outbox-notify', '--verify-standalone-scheduler-rls', '--verify-standalone-route-cost-matrix-full-key'].includes(command) && process.env.EWOH_ALLOW_DDL !== '1') {
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
      // 期望值来源：standalone_005_verify.sql 自述（2 张新表 / 6 个 org_id 列 / 1 个默认视图唯一索引），
      // 与迁移 005 的结构契约一致（非漂移源，自包含验证）。
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
      // 期望值来源：standalone_010_verify.sql 自述（feedback 表 16 列 / 4 索引）。
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
      // 期望值来源：standalone_006_verify.sql 自述（7 张 V2 表 / 7 个 V2 列 / 1 个 version 列）。
      if (tableCount !== 7 || v2Columns !== 7 || versionCol !== 1) {
        console.error(`VERIFY FAILED: expected (7,7,1), got (${tableCount},${v2Columns},${versionCol})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling V2 tables + ewoh_schedule_plan V2 columns present');
      }
      return;
    }

    if (command === '--verify-standalone-outbox-sequence') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_outbox_sequence_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const exists = Number(row.outbox_sequence_exists || 0);
      const hasDefault = Number(row.outbox_sequence_default || 0);
      // 期望值来源：standalone_011_verify.sql 自述（序列存在 1 / sequence 列 DEFAULT 使用序列 1）。
      if (exists !== 1 || hasDefault !== 1) {
        console.error(`VERIFY FAILED: expected (1,1), got (${exists},${hasDefault})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: outbox sequence exists and ewoh_outbox.sequence DEFAULT uses it');
      }
      return;
    }

    if (command === '--verify-standalone-conflict-lifecycle') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_conflict_lifecycle_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.conflict_columns || 0);
      const indexes = Number(row.conflict_indexes || 0);
      const statusDefault = Number(row.conflict_status_default || 0);
      // 期望值来源：standalone_013_conflict_lifecycle.verify.sql 自述（19 列 / 4 索引 / 1 默认 OPEN）。
      if (columns !== 19 || indexes !== 4 || statusDefault !== 1) {
        console.error(`VERIFY FAILED: expected (19,4,1), got (${columns},${indexes},${statusDefault})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: conflict lifecycle table + status default OPEN present');
      }
      return;
    }

    if (command === '--verify-standalone-task-requirement') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_task_requirement_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const nullRows = Number(row.null_required_device_capability_rows || 0);
      // verify.sql 内 DO 块失败会整体抛错；此处额外断言 backfill 无 NULL 残留。
      if (nullRows > 0) {
        console.error(`VERIFY FAILED: ${nullRows} rows have NULL required_device_capabilities`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: TaskRequirement columns + backfill complete');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling-tables-fix') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_tables_fix_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      // 多语句执行返回结果数组；主查询是最后一条（DO 块无返回行）。
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.outbox_key_cols || 0) >= 5
        && Number(row.reservation_key_cols || 0) >= 5
        && Number(row.policy_key_cols || 0) >= 4
        && Number(row.replan_trigger_key_cols || 0) >= 4;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduling tables missing key columns (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling tables (outbox/reservation/policy) present with key columns');
      }
      return;
    }

    if (command === '--verify-standalone-execution-feedback') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_execution_feedback_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.exec_key_cols || 0) >= 7 && Number(row.exec_indexes || 0) >= 5;
      if (!ok) {
        console.error(`VERIFY FAILED: execution table missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_scheduling_execution present with key columns + indexes');
      }
      return;
    }

    if (command === '--verify-standalone-kpi-replay') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_kpi_replay_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.replay_key_cols || 0) >= 6;
      if (!ok) {
        console.error(`VERIFY FAILED: kpi/replay tables missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: kpi + policy_replay tables present');
      }
      return;
    }

    if (command === '--verify-standalone-policy-lifecycle') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_policy_lifecycle_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.activation_key_cols || 0) >= 5;
      if (!ok) {
        console.error(`VERIFY FAILED: policy lifecycle missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: policy.status + activation + plan.is_shadow present');
      }
      return;
    }

    if (command === '--verify-standalone-sse-envelope') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_sse_envelope_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.outbox_indexes || 0) >= 4;
      if (!ok) {
        console.error(`VERIFY FAILED: sse envelope missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: outbox.correlation_id + sequence index present');
      }
      return;
    }

    if (command === '--verify-standalone-reservation-capacity') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_reservation_capacity_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // DO 块内 RAISE EXCEPTION 会整体抛错；此处对返回行做防御断言。
      // 期望：表存在=1、person/device 过滤约束存在=1、旧的未过滤约束已移除=0。
      const tableOk = Number(row.reservation_table_exists || 0) === 1;
      const guardOk = Number(row.person_device_guard || 0) === 1;
      const oldDropped = Number(row.old_binary_guard_dropped || 0) === 0;
      if (!tableOk || !guardOk || !oldDropped) {
        console.error(`VERIFY FAILED: reservation capacity guard misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: person/device scoped exclusion present; station capacity left to app layer');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-incremental') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_incremental_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：constraint 新列=6 / constraint 索引=2 / plan 新列=2 / spatial 新列=2 /
      // device 新列=1 / RLS policy=1（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.constraint_new_cols || 0) >= 6
        && Number(row.constraint_indexes || 0) >= 2
        && Number(row.plan_new_cols || 0) >= 2
        && Number(row.spatial_new_cols || 0) >= 2
        && Number(row.device_new_cols || 0) >= 1
        && Number(row.rls_policies || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduler incremental columns/policies misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduler incremental columns + indexes + RLS policy present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-outbox-notify') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_outbox_notify_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：ewoh_outbox 的 AFTER INSERT notify trigger=1 / notify_scheduler_outbox 函数=1
      // （DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.outbox_notify_trigger || 0) >= 1
        && Number(row.outbox_notify_function || 0) >= 1;
      if (!ok) {
        console.error(`VERIFY FAILED: outbox notify trigger/function missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_outbox AFTER INSERT notify trigger + function present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-rls') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_rls_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：8 张 org-scoped 表 RLS 启用 / 8 条 policy / 8 条 policy 定义含 app.current_org_id /
      // ewoh_schedule_plan.org_id 列=1（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.rls_enabled || 0) >= 8
        && Number(row.policy_count || 0) >= 8
        && Number(row.policy_guc || 0) >= 8
        && Number(row.plan_org_col || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduler RLS coverage misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduler domain RLS enabled with current_org_id GUC policies');
      }
      return;
    }

    if (command === '--verify-standalone-route-cost-matrix-full-key') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_route_cost_matrix_full_key_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：全键列=2 / 全键索引=1 / 唯一=1
      // （DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.full_key_columns || 0) >= 2
        && Number(row.full_key_index || 0) === 1
        && Number(row.full_key_unique || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: route cost matrix full-key unique index misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: route cost matrix full-key unique index present');
      }
      return;
    }

    if (command === '--verify-standalone-policy-weights') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_policy_weights_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const policyCol = Number(row.policy_weights_json || 0);
      const planCol = Number(row.plan_weights_json || 0);
      // 期望值来源：standalone_014_policy_weights.verify.sql 自述（policy=1 / plan=1）。
      if (policyCol !== 1 || planCol !== 1) {
        console.error(`VERIFY FAILED: expected (1,1), got (${policyCol},${planCol})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: policy + plan weights_json columns present');
      }
      return;
    }

    if (command === '--verify-standalone-route-cost-matrix') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_route_cost_matrix_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.route_cost_matrix_columns || 0);
      const indexes = Number(row.route_cost_matrix_indexes || 0);
      const uq = Number(row.route_cost_matrix_uq || 0);
      // 期望值来源：standalone_015_route_cost_matrix.verify.sql 自述（11 列 / 3 索引 / 1 唯一键）。
      if (columns !== 11 || indexes !== 3 || uq !== 1) {
        console.error(`VERIFY FAILED: expected (11,3,1), got (${columns},${indexes},${uq})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: route cost matrix cache table + unique key present');
      }
      return;
    }

    if (command === '--verify-standalone-domain-columns') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_domain_columns_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const taskCols = Number(row.task_domain_columns || 0);
      const personnelCols = Number(row.personnel_domain_columns || 0);
      const deviceCols = Number(row.device_domain_columns || 0);
      const spatialCols = Number(row.spatial_domain_columns || 0);
      const runFailure = Number(row.run_failure_reason || 0);
      const safetyDefault = Number(row.safety_critical_default || 0);
      const preemptibleDefault = Number(row.preemptible_default || 0);
      const skillModeDefault = Number(row.skill_match_mode_default || 0);
      const impactDefault = Number(row.production_impact_default || 0);
      // 期望值来源：standalone_012_domain_columns.verify.sql 自述（(11,4,7,3,1,1,1,1,1)）。
      if (
        taskCols !== 11 || personnelCols !== 4 || deviceCols !== 7 ||
        spatialCols !== 3 || runFailure !== 1 ||
        safetyDefault !== 1 || preemptibleDefault !== 1 ||
        skillModeDefault !== 1 || impactDefault !== 1
      ) {
        console.error(
          `VERIFY FAILED: expected (11,4,7,3,1,1,1,1,1), got (${taskCols},${personnelCols},${deviceCols},${spatialCols},${runFailure},${safetyDefault},${preemptibleDefault},${skillModeDefault},${impactDefault})`,
        );
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: domain-model columns present with correct defaults');
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
      '--apply-standalone-scheduling-persistence': 'standalone_scheduling_persistence',
      '--rollback-standalone-scheduling-persistence': 'standalone_scheduling_persistence_rollback',
      '--apply-standalone-phase2-realtime': 'standalone_phase2_realtime',
      '--rollback-standalone-phase2-realtime': 'standalone_phase2_realtime_rollback',
      '--apply-standalone-reservation-conflict': 'standalone_reservation_conflict',
      '--rollback-standalone-reservation-conflict': 'standalone_reservation_conflict_rollback',
      '--apply-standalone-scheduling-feedback': 'standalone_scheduling_feedback',
      '--rollback-standalone-scheduling-feedback': 'standalone_scheduling_feedback_rollback',
      '--apply-standalone-outbox-sequence': 'standalone_outbox_sequence',
      '--rollback-standalone-outbox-sequence': 'standalone_outbox_sequence_rollback',
      '--apply-standalone-domain-columns': 'standalone_domain_columns',
      '--rollback-standalone-domain-columns': 'standalone_domain_columns_rollback',
      '--apply-standalone-route-cost-matrix': 'standalone_route_cost_matrix',
      '--rollback-standalone-route-cost-matrix': 'standalone_route_cost_matrix_rollback',
      '--apply-standalone-policy-weights': 'standalone_policy_weights',
      '--rollback-standalone-policy-weights': 'standalone_policy_weights_rollback',
      '--apply-standalone-conflict-lifecycle': 'standalone_conflict_lifecycle',
      '--rollback-standalone-conflict-lifecycle': 'standalone_conflict_lifecycle_rollback',
      '--apply-standalone-task-requirement': 'standalone_task_requirement',
      '--rollback-standalone-task-requirement': 'standalone_task_requirement_rollback',
      '--apply-standalone-scheduling-tables-fix': 'standalone_scheduling_tables_fix',
      '--rollback-standalone-scheduling-tables-fix': 'standalone_scheduling_tables_fix_rollback',
      '--apply-standalone-execution-feedback': 'standalone_execution_feedback',
      '--rollback-standalone-execution-feedback': 'standalone_execution_feedback_rollback',
      '--apply-standalone-kpi-replay': 'standalone_kpi_replay',
      '--rollback-standalone-kpi-replay': 'standalone_kpi_replay_rollback',
      '--apply-standalone-policy-lifecycle': 'standalone_policy_lifecycle',
      '--rollback-standalone-policy-lifecycle': 'standalone_policy_lifecycle_rollback',
      '--apply-standalone-sse-envelope': 'standalone_sse_envelope',
      '--rollback-standalone-sse-envelope': 'standalone_sse_envelope_rollback',
      '--apply-standalone-reservation-capacity': 'standalone_reservation_capacity',
      '--rollback-standalone-reservation-capacity': 'standalone_reservation_capacity_rollback',
      '--apply-standalone-scheduler-incremental': 'standalone_scheduler_incremental',
      '--rollback-standalone-scheduler-incremental': 'standalone_scheduler_incremental_rollback',
      '--apply-standalone-scheduler-outbox-notify': 'standalone_scheduler_outbox_notify',
      '--rollback-standalone-scheduler-outbox-notify': 'standalone_scheduler_outbox_notify_rollback',
      '--apply-standalone-scheduler-rls': 'standalone_scheduler_rls',
      '--rollback-standalone-scheduler-rls': 'standalone_scheduler_rls_rollback',
      '--apply-standalone-route-cost-matrix-full-key': 'standalone_route_cost_matrix_full_key',
      '--rollback-standalone-route-cost-matrix-full-key': 'standalone_route_cost_matrix_full_key_rollback',
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
