#!/usr/bin/env node
/* EWOH PostgreSQL production migration gate (runtime gate #1).
 *
 * Exercises the standalone migration runner against a DISPOSABLE database and
 * emits a machine-readable report. The migration under test is
 * standalone_005_workbench_prod (org_id tenant columns + saved_views +
 * workbench_export_tasks).
 *
 * Gates exercised:
 *   A. empty-DB upgrade        — apply the full standalone chain (001..005) onto
 *                                a freshly-created schema.
 *   B. upgrade-from-previous   — apply up to standalone_004 (domain), then apply
 *                                standalone_005 on top (the "previous version"
 *                                upgrade path).
 *   C. repeated execution      — re-apply standalone_005 (idempotent, IF NOT
 *                                EXISTS) and confirm verify still holds.
 *   D. failure rollback        — destructive rollback of standalone_005, confirm
 *                                artifacts are gone, then re-apply.
 *   E. production permission   — service_role grants on the new tables exist and
 *                                the runtime role is a member of service_role.
 *
 * Env:
 *   EWOH_MIGRATION_TEST_DB_URL  (required) disposable PostgreSQL URL (superuser).
 *   EWOH_ALLOW_DDL              set to 1 by this script.
 *   EWOH_ALLOW_DESTRUCTIVE_ROLLBACK set to 1 by this script.
 *
 * If the DB is unreachable the gate is recorded BLOCKED_BY_ENVIRONMENT (never
 * PASS) and the report reflects that. Exit code is 0 for BLOCKED, 1 for FAILED.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'db', 'runner', 'run_migrations.js');
const reportPath = path.join(root, 'output', 'migration-prod-report.json');
const GATE_ID = 'postgres-migration-prod';

let postgres;
try {
  postgres = (await import('../ewoh-spark-app/node_modules/postgres/src/index.js')).default;
} catch {
  postgres = null;
}

function recordGate(status, details) {
  const args = [
    path.join(root, 'scripts', 'truth-gate-record.js'),
    '--id', GATE_ID,
    '--name', 'PostgreSQL 生产迁移门禁（空库/跨版本/幂等/回滚/权限模型）',
    '--status', status,
    '--details', details,
  ];
  spawnSync(process.execPath, args, { stdio: 'inherit' });
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const url = process.env.EWOH_MIGRATION_TEST_DB_URL;
  if (!url) {
    const msg = 'EWOH_MIGRATION_TEST_DB_URL is required (disposable PostgreSQL URL)';
    console.error('::notice::BLOCKED_BY_ENVIRONMENT: ' + msg);
    recordGate('BLOCKED_BY_ENVIRONMENT', '未设置 EWOH_MIGRATION_TEST_DB_URL');
    fs.writeFileSync(reportPath, JSON.stringify({
      gate: GATE_ID, status: 'BLOCKED_BY_ENVIRONMENT', checkedAt: nowIso(),
      reason: msg, gates: [],
    }, null, 2) + '\n');
    return 0;
  }
  if (!postgres) {
    const msg = 'postgres driver unavailable (node_modules not installed)';
    console.error('::notice::BLOCKED_BY_ENVIRONMENT: ' + msg);
    recordGate('BLOCKED_BY_ENVIRONMENT', msg);
    fs.writeFileSync(reportPath, JSON.stringify({
      gate: GATE_ID, status: 'BLOCKED_BY_ENVIRONMENT', checkedAt: nowIso(),
      reason: msg, gates: [],
    }, null, 2) + '\n');
    return 0;
  }

  const sql = postgres(url, { max: 2, idle_timeout: 30_000, onnotice: () => {} });
  const report = { gate: GATE_ID, checkedAt: nowIso(), gates: [] };
  const results = [];

  const exec = (label) => (command, args) => {
    const res = spawnSync(command, args, {
      cwd: root, encoding: 'utf8',
      env: {
        ...process.env,
        EWOH_DATABASE_URL: url,
        EWOH_ALLOW_DDL: '1',
        EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '1',
        EWOH_API_DATABASE_PASSWORD: report.runtimePassword,
        EWOH_BOOTSTRAP_ADMIN_USERNAME: 'mig_gate_admin',
        EWOH_BOOTSTRAP_ADMIN_PASSWORD: report.adminPassword,
      },
    });
    if (res.error) throw new Error(`${label}: spawn error ${res.error.message}`);
    if (res.status !== 0) {
      const tail = (res.stderr || res.stdout || '').split('\n').slice(-8).join('\n');
      throw new Error(`${label}: exit ${res.status}\n${tail}`);
    }
  };

  const run = exec('migration');

  const connect = async () => {
    try {
      await sql`select 1`;
      return true;
    } catch {
      return false;
    }
  };

  const resetSchema = async () => {
    await sql.unsafe('drop schema if exists public cascade');
    await sql.unsafe('create schema public');
  };

  const workbenchArtifacts = async () => {
    const [tables] = await sql.unsafe(`
      select
        (select count(*) from information_schema.tables
          where table_schema='public' and table_name in ('saved_views','workbench_export_tasks'))::int as tables,
        (select count(*) from information_schema.columns
          where table_schema='public' and column_name='org_id'
            and table_name in ('ewoh_schedule_task','ewoh_schedule_task_step','ewoh_event',
                               'ewoh_world_state','ewoh_spatial_entity','ewoh_resource_binding'))::int as org_cols
    `);
    return { tables: Number(tables.tables), orgCols: Number(tables.org_cols) };
  };

  const permissionModel = async () => {
    const [grants] = await sql.unsafe(`
      select
        (select count(*) from information_schema.table_privileges
          where grantee='service_role'
            and table_name in ('saved_views','workbench_export_tasks'))::int as svc_grants,
        (select count(*) from pg_roles where rolname='service_role')::int as svc_role_exists,
        (select count(*) from pg_auth_members m
          join pg_roles r on r.oid=m.roleid and r.rolname='service_role'
          join pg_roles member on member.oid=m.member
          where member.rolname='ewoh_api')::int as runtime_member
    `);
    return {
      serviceRoleGrants: Number(grants.svc_grants),
      serviceRoleExists: Number(grants.svc_role_exists),
      runtimeIsMember: Number(grants.runtime_member),
    };
  };

  try {
    if (!(await connect())) {
      const msg = `数据库不可达: ${url}`;
      console.error('::notice::BLOCKED_BY_ENVIRONMENT: ' + msg);
      recordGate('BLOCKED_BY_ENVIRONMENT', msg);
      report.status = 'BLOCKED_BY_ENVIRONMENT';
      report.reason = msg;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      return 0;
    }

    report.runtimePassword = crypto.randomBytes(24).toString('hex');
    report.adminPassword = crypto.randomBytes(24).toString('hex');

    // ---- Gate A: empty-DB upgrade ----
    {
      await resetSchema();
      await run(process.execPath, [runner, '--apply-standalone']);
      await run(process.execPath, [runner, '--apply-standalone-users']);
      await run(process.execPath, [runner, '--apply-standalone-runtime-role']);
      await run(process.execPath, [runner, '--apply-standalone-domain']);
      await run(process.execPath, [runner, '--apply-standalone-workbench-prod']);
      const verify = await run(process.execPath, [runner, '--verify-standalone-workbench-prod']);
      results.push({ id: 'empty-db-upgrade', ok: true, detail: 'full chain 001..005 applied + verify' });
    }

    // ---- Gate B: upgrade-from-previous ----
    {
      await resetSchema();
      await run(process.execPath, [runner, '--apply-standalone']);
      await run(process.execPath, [runner, '--apply-standalone-users']);
      await run(process.execPath, [runner, '--apply-standalone-runtime-role']);
      await run(process.execPath, [runner, '--apply-standalone-domain']);
      const before = await workbenchArtifacts();
      if (before.tables !== 0) throw new Error('upgrade-from-previous: workbench tables should not exist before 005');
      await run(process.execPath, [runner, '--apply-standalone-workbench-prod']);
      const after = await workbenchArtifacts();
      if (after.tables !== 2 || after.orgCols !== 6) {
        throw new Error(`upgrade-from-previous: expected (2,6) got (${after.tables},${after.orgCols})`);
      }
      results.push({ id: 'upgrade-from-previous', ok: true, detail: '005 applied over 004 baseline' });
    }

    // ---- Gate C: repeated execution (idempotent) ----
    {
      await run(process.execPath, [runner, '--apply-standalone-workbench-prod']);
      await run(process.execPath, [runner, '--apply-standalone-workbench-prod']);
      await run(process.execPath, [runner, '--verify-standalone-workbench-prod']);
      const after = await workbenchArtifacts();
      if (after.tables !== 2 || after.orgCols !== 6) {
        throw new Error(`idempotent: expected (2,6) got (${after.tables},${after.orgCols})`);
      }
      results.push({ id: 'idempotent-reapply', ok: true, detail: 're-applied twice, no error, verify holds' });
    }

    // ---- Gate D: failure rollback ----
    {
      await run(process.execPath, [runner, '--rollback-standalone-workbench-prod']);
      const cleared = await workbenchArtifacts();
      if (cleared.tables !== 0 || cleared.orgCols !== 0) {
        throw new Error(`rollback: expected (0,0) got (${cleared.tables},${cleared.orgCols})`);
      }
      await run(process.execPath, [runner, '--apply-standalone-workbench-prod']); // re-apply
      await run(process.execPath, [runner, '--verify-standalone-workbench-prod']);
      results.push({ id: 'rollback', ok: true, detail: 'destructive rollback cleaned artifacts, re-apply restored' });
    }

    // ---- Gate E: production permission model ----
    {
      const perm = await permissionModel();
      if (perm.serviceRoleGrants !== 8 || perm.serviceRoleExists !== 1 || perm.runtimeIsMember !== 1) {
        throw new Error(`permission model invalid: ${JSON.stringify(perm)}`);
      }
      results.push({ id: 'permission-model', ok: true, detail: JSON.stringify(perm) });
    }

    report.status = 'SUCCEEDED';
    report.results = results;
    report.gates = results;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('SUCCEEDED', `5/5 迁移门禁通过: ${results.map((r) => r.id).join(', ')}`);
    console.log('MIGRATION-PROD OK: ' + results.map((r) => r.id).join(' -> '));
    return 0;
  } catch (error) {
    report.status = 'FAILED';
    report.results = results;
    report.error = (error && (error.message || String(error)));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('FAILED', report.error);
    console.error('MIGRATION-PROD FAILED: ' + report.error);
    return 1;
  } finally {
    try { await sql.end(); } catch { /* ignore */ }
  }
}

main().then((code) => { process.exitCode = code; });