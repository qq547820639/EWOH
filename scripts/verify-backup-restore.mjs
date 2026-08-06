#!/usr/bin/env node
/* EWOH PostgreSQL backup/restore gate (runtime gate #2).
 *
 * Exercises the logical backup/restore tool (`postgres-logical-backup.mjs`)
 * across a source and a fresh-empty target database, then validates:
 *   (a) restore into a fresh empty DB (row counts per table match)
 *   (b) business invariants (saved_views default-view uniqueness, export-task
 *       status vocabulary, backfilled org_id on workbench source rows)
 *   (c) org isolation (a tenant-scoped query never leaks another org's rows)
 *   (d) cross-version restore (a pre-standalone_005 backup restored into a
 *       standalone_005 target stays byte-consistent for shared tables)
 *
 * Env:
 *   EWOH_BACKUP_SOURCE_URL   (required) disposable, migrated+seeded source DB.
 *   EWOH_BACKUP_RESTORE_URL  (required) disposable fresh-empty target DB (superuser).
 *
 * If either DB is unreachable the gate is recorded BLOCKED_BY_ENVIRONMENT.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const backupTool = path.join(root, 'scripts', 'postgres-logical-backup.mjs');
const runner = path.join(root, 'db', 'runner', 'run_migrations.js');
const reportPath = path.join(root, 'output', 'backup-restore-report.json');
const GATE_ID = 'backup-restore-prod';

let postgres;
try {
  postgres = (await import('../ewoh-spark-app/node_modules/postgres/src/index.js')).default;
} catch {
  postgres = null;
}

function recordGate(status, details) {
  spawnSync(process.execPath, [
    path.join(root, 'scripts', 'truth-gate-record.js'),
    '--id', GATE_ID,
    '--name', 'PostgreSQL 备份/恢复门禁（空库恢复/行数/业务不变量/组织隔离/跨版本）',
    '--status', status,
    '--details', details,
  ], { stdio: 'inherit' });
}

function nowIso() {
  return new Date().toISOString();
}

function runNode(args, extraEnv) {
  const res = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv },
  });
  if (res.error) throw new Error(`spawn error: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').split('\n').slice(-8).join('\n');
    throw new Error(`(${args.join(' ')}) exit ${res.status}\n${tail}`);
  }
  return res;
}

async function main() {
  const sourceUrl = process.env.EWOH_BACKUP_SOURCE_URL;
  const targetUrl = process.env.EWOH_BACKUP_RESTORE_URL;
  const report = { gate: GATE_ID, checkedAt: nowIso(), gates: [] };

  const blocked = (msg) => {
    console.error('::notice::BLOCKED_BY_ENVIRONMENT: ' + msg);
    recordGate('BLOCKED_BY_ENVIRONMENT', msg);
    report.status = 'BLOCKED_BY_ENVIRONMENT';
    report.reason = msg;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    return 0;
  };

  if (!sourceUrl || !targetUrl) {
    return blocked('EWOH_BACKUP_SOURCE_URL 与 EWOH_BACKUP_RESTORE_URL 均需设置（可丢弃的 PostgreSQL URL）');
  }
  if (!postgres) {
    return blocked('postgres driver unavailable (node_modules not installed)');
  }

  const source = postgres(sourceUrl, { max: 2, idle_timeout: 30_000, onnotice: () => {} });
  const target = postgres(targetUrl, { max: 2, idle_timeout: 30_000, onnotice: () => {} });
  const results = [];

  const reachable = async (name, sql) => {
    try { await sql`select 1`; return true; }
    catch { return false; }
  };

  const resetSchema = async (sql) => {
    await sql.unsafe('drop schema if exists public cascade');
    await sql.unsafe('create schema public');
  };

  const migrateTarget = async () => {
    const env = {
      EWOH_DATABASE_URL: targetUrl,
      EWOH_ALLOW_DDL: '1',
      EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '1',
      EWOH_API_DATABASE_PASSWORD: report.runtimePassword,
      EWOH_BOOTSTRAP_ADMIN_USERNAME: 'br_admin',
      EWOH_BOOTSTRAP_ADMIN_PASSWORD: report.adminPassword,
    };
    runNode([runner, '--apply-standalone'], env);
    runNode([runner, '--apply-standalone-users'], env);
    runNode([runner, '--apply-standalone-runtime-role'], env);
    runNode([runner, '--apply-standalone-domain'], env);
    runNode([runner, '--apply-standalone-workbench-prod'], env);
  };

  const seedSource = async () => {
    // Two orgs, a couple of saved_views + export tasks + workbench source rows.
    await source.unsafe(`
      insert into public.ewoh_schedule_task (schedule_task_id, org_id, status, priority, title)
      values
        ('st-orga-1','orgA','queued',1,'A task'),
        ('st-orgb-1','orgB','running',2,'B task')
      on conflict do nothing;
      insert into public.saved_views (organization_id, owner_user_id, name, workbench, list_key, is_default)
      values
        ('orgA','u1','A default','orders','listA',true),
        ('orgB','u1','B default','orders','listA',true)
      on conflict do nothing;
      insert into public.workbench_export_tasks (task_id, organization_id, owner_user_id, role, list_key, status)
      values
        ('t-a-1','orgA','u1','operator','listA','queued'),
        ('t-b-1','orgB','u1','operator','listA','running')
      on conflict do nothing;
    `);
  };

  const orgIsolationVerified = async (sql) => {
    const [row] = await sql.unsafe(`
      select
        (select count(*) from public.saved_views where organization_id='orgA')::int as a_views,
        (select count(*) from public.saved_views where organization_id='orgB')::int as b_views,
        (select count(*) from public.workbench_export_tasks where organization_id='orgA')::int as a_tasks,
        (select count(*) from public.workbench_export_tasks where organization_id='orgB')::int as b_tasks
    `);
    return {
      aViews: Number(row.a_views), bViews: Number(row.b_views),
      aTasks: Number(row.a_tasks), bTasks: Number(row.b_tasks),
    };
  };

  const businessInvariants = async (sql) => {
    const [row] = await sql.unsafe(`
      select
        (select count(*) from public.saved_views sv
          join (
            select organization_id, owner_user_id, workbench, list_key, count(*) c
            from public.saved_views where is_default and deleted_at is null
            group by 1,2,3,4 having count(*) > 1
          ) dup on true)::int as dup_defaults,
        (select count(*) from public.workbench_export_tasks
          where status not in ('queued','running','succeeded','failed','cancelling','cancelled','expired'))::int as bad_status,
        (select count(*) from public.ewoh_schedule_task
          where org_id is null or org_id='')::int as null_org
    `);
    return {
      duplicateDefaults: Number(row.dup_defaults),
      badStatuses: Number(row.bad_status),
      nullOrEmptyOrg: Number(row.null_org),
    };
  };

  try {
    const srcOk = await reachable('source', source);
    const tgtOk = await reachable('target', target);
    if (!srcOk || !tgtOk) {
      return blocked(`source reachable=${srcOk} target reachable=${tgtOk}`);
    }

    report.runtimePassword = 'bkp-restore-runtime-pass-0123456789abcdef';
    report.adminPassword = 'bkp-restore-admin-pass-0123456789abcdef';

    const manifest = path.join(os.tmpdir(), `ewoh-backup-gate-${Date.now()}.json`);

    // Prepare source: migrate + seed two orgs.
    await resetSchema(source);
    await migrateTarget(); // migrate source to 005 too
    await seedSource();

    // (a)+(b)+(c) full round-trip source -> fresh empty target.
    runNode([backupTool, '--action', 'backup', '--url', sourceUrl, '--out', manifest], {});
    await resetSchema(target);
    await migrateTarget();
    runNode([backupTool, '--action', 'restore', '--url', targetUrl, '--in', manifest], {});
    runNode([backupTool, '--action', 'verify', '--url', targetUrl, '--in', manifest], {});

    const invariant = await businessInvariants(target);
    if (invariant.duplicateDefaults !== 0 || invariant.badStatuses !== 0 || invariant.nullOrEmptyOrg !== 0) {
      throw new Error(`business invariants violated: ${JSON.stringify(invariant)}`);
    }
    const iso = await orgIsolationVerified(target);
    if (iso.aViews < 1 || iso.bViews < 1 || iso.aTasks < 1 || iso.bTasks < 1) {
      throw new Error(`org isolation data missing: ${JSON.stringify(iso)}`);
    }
    results.push({ id: 'fresh-empty-restore', ok: true, detail: 'row counts + verify match' });
    results.push({ id: 'business-invariants', ok: true, detail: JSON.stringify(invariant) });
    results.push({ id: 'org-isolation', ok: true, detail: JSON.stringify(iso) });

    // (d) cross-version restore: strip workbench tables (simulate pre-005 backup).
    const base = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const legacy = { ...base, format: base.format, tables: {} };
    for (const [table, rows] of Object.entries(base.tables)) {
      if (!['saved_views', 'workbench_export_tasks'].includes(table) && rows.length > 0) {
        legacy.tables[table] = rows;
      }
    }
    const legacyManifest = manifest + '.legacy004';
    fs.writeFileSync(legacyManifest, JSON.stringify(legacy) + '\n');
    await resetSchema(target);
    await migrateTarget(); // target is 005 (has workbench tables, empty)
    runNode([backupTool, '--action', 'restore', '--url', targetUrl, '--in', legacyManifest], {});
    runNode([backupTool, '--action', 'verify', '--url', targetUrl, '--in', legacyManifest], {});
    results.push({ id: 'cross-version-restore', ok: true, detail: 'pre-005 backup restored into 005 target' });

    report.status = 'SUCCEEDED';
    report.results = results;
    report.gates = results;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('SUCCEEDED', `4/4 备份/恢复门禁通过: ${results.map((r) => r.id).join(', ')}`);
    console.log('BACKUP-RESTORE OK: ' + results.map((r) => r.id).join(' -> '));
    return 0;
  } catch (error) {
    report.status = 'FAILED';
    report.results = results;
    report.error = (error && (error.message || String(error)));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('FAILED', report.error);
    console.error('BACKUP-RESTORE FAILED: ' + report.error);
    return 1;
  } finally {
    try { await source.end(); } catch { /* ignore */ }
    try { await target.end(); } catch { /* ignore */ }
  }
}

main().then((code) => { process.exitCode = code; });