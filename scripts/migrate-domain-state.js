#!/usr/bin/env node
'use strict';

/*
 * EWOH F61-02 (2.A): import domain state from legacy artifacts into the
 * new domain persistence tables (standalone_004_ewoh_domain.sql).
 *
 * Sources (all optional; missing files/dirs are skipped):
 *   .codex/artifacts/work/locks/*.json        -> ewoh_resource_locks
 *   .codex/artifacts/work/git-sync.json       -> ewoh_git_sync_state
 *   .codex/artifacts/work/git-sync-apply.json -> ewoh_handoffs
 *   .codex/artifacts/work/handoffs/*.md       -> ewoh_handoffs
 *
 * Idempotent: every insert uses ON CONFLICT ... DO NOTHING.
 * --dry-run prints the plan without touching the database.
 * Uses the same postgres driver as run_migrations.js (EWOH_DATABASE_URL or SUDA_DATABASE_URL).
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

const ARTIFACTS_DIR = path.join(root, '.codex', 'artifacts', 'work');
const SCHEMA = process.env.EWOH_SCHEMA || 'public';
const DRY_RUN = process.argv.includes('--dry-run');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[skip] unreadable ${file}: ${err.message}`);
    return null;
  }
}

function listFiles(pattern) {
  const dir = path.dirname(pattern);
  const ext = path.extname(pattern);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => ext === '' || f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

function qualify(table) {
  return `${SCHEMA}.${table}`;
}

function planStatement(table, rows) {
  return { table, rows: rows.length };
}

// --- builders: each returns an array of row objects (insert params) ---

function locksRows() {
  const files = listFiles(path.join(ARTIFACTS_DIR, 'locks', '*.json'));
  const rows = [];
  for (const file of files) {
    const data = readJson(file);
    if (!data) continue;
    const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : { resource_key: path.basename(file, '.json') };
    rows.push({
      org_id: String(obj.org_id || 'default'),
      resource_key: String(obj.resource_key || obj.key || path.basename(file, '.json')),
      resource_id: obj.resource_id != null ? String(obj.resource_id) : null,
      holder: obj.holder != null ? String(obj.holder) : null,
      purpose: obj.purpose != null ? String(obj.purpose) : null,
      acquired_at: obj.acquired_at || null,
      expires_at: obj.expires_at || null,
      renewed_at: obj.renewed_at || null,
      active: obj.active != null ? Boolean(obj.active) : true,
      version: obj.version != null ? Number(obj.version) : 1,
    });
  }
  return rows;
}

function gitSyncRows() {
  const file = path.join(ARTIFACTS_DIR, 'git-sync.json');
  if (!fs.existsSync(file)) return [];
  const data = readJson(file);
  if (!data) return [];
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return [{
    sync_id: String(obj.sync_id || obj.id || 'default'),
    last_sync_at: obj.last_sync_at || null,
    last_sync_sha: obj.last_sync_sha || obj.sha || null,
    last_sync_status: obj.last_sync_status || obj.status || null,
    conflicts: obj.conflicts != null ? JSON.stringify(obj.conflicts) : null,
  }];
}

function handoffsRows() {
  const rows = [];
  // git-sync-apply.json -> a single handoff apply record
  const applyFile = path.join(ARTIFACTS_DIR, 'git-sync-apply.json');
  if (fs.existsSync(applyFile)) {
    const data = readJson(applyFile);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      rows.push({
        handoff_id: String(data.handoff_id || data.id || 'git-sync-apply'),
        from_actor: data.from_actor != null ? String(data.from_actor) : 'system',
        to_actor: data.to_actor != null ? String(data.to_actor) : 'workbench',
        scope: data.scope != null ? String(data.scope) : 'git-sync',
        context_pack: data.context_pack != null ? String(data.context_pack) : null,
        acceptance: data.acceptance != null ? String(data.acceptance) : null,
        open_questions: data.open_questions != null ? JSON.stringify(data.open_questions) : null,
        state: data.state || 'open',
        accepted_at: data.accepted_at || null,
        closed_at: data.closed_at || null,
      });
    }
  }
  // handoffs/*.md -> parse simple frontmatter (JSON lines or key: value blocks)
  const files = listFiles(path.join(ARTIFACTS_DIR, 'handoffs', '*.md'));
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const row = {
      handoff_id: path.basename(file, '.md'),
      from_actor: 'system',
      to_actor: 'workbench',
      scope: 'handoff',
      context_pack: content.slice(0, 4000),
      acceptance: null,
      open_questions: null,
      state: 'open',
      accepted_at: null,
      closed_at: null,
    };
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k === 'handoff_id' || k === 'to_actor' || k === 'from_actor' || k === 'scope' || k === 'state') row[k] = v;
      }
    }
    rows.push(row);
  }
  return rows;
}

function main() {
  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;

  const plans = [
    planStatement('ewoh_resource_locks', locksRows()),
    planStatement('ewoh_git_sync_state', gitSyncRows()),
    planStatement('ewoh_handoffs', handoffsRows()),
  ];
  const total = plans.reduce((n, p) => n + p.rows, 0);

  console.log(`EWOH domain state import | schema=${SCHEMA} | mode=${DRY_RUN ? 'dry-run' : 'apply'}`);
  for (const p of plans) {
    console.log(`  plan: ${p.table} -> ${p.rows} row(s)`);
  }
  console.log(`total planned rows: ${total}`);

  if (DRY_RUN) {
    console.log('Dry run: no database writes performed.');
    return;
  }
  if (!url) {
    console.error('EWOH_DATABASE_URL or SUDA_DATABASE_URL is required (unless --dry-run).');
    process.exit(2);
  }
  if (!['public'].includes(SCHEMA) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
    console.error(`Invalid EWOH_SCHEMA: ${SCHEMA}`);
    process.exit(2);
  }

  const postgres = requireFromApp('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  (async () => {
    await sql.begin(async (tx) => {
      const locks = locksRows();
      for (const r of locks) {
        await tx`insert into ${sql(qualify('ewoh_resource_locks'))} (org_id, resource_key, resource_id, holder, purpose, acquired_at, expires_at, renewed_at, active, version)
          values (${r.org_id}, ${r.resource_key}, ${r.resource_id}, ${r.holder}, ${r.purpose}, ${r.acquired_at}, ${r.expires_at}, ${r.renewed_at}, ${r.active}, ${r.version})
          on conflict (org_id, resource_key) do nothing`;
      }
      for (const r of gitSyncRows()) {
        await tx`insert into ${sql(qualify('ewoh_git_sync_state'))} (sync_id, last_sync_at, last_sync_sha, last_sync_status, conflicts)
          values (${r.sync_id}, ${r.last_sync_at}, ${r.last_sync_sha}, ${r.last_sync_status}, ${r.conflicts})
          on conflict (sync_id) do nothing`;
      }
      for (const r of handoffsRows()) {
        await tx`insert into ${sql(qualify('ewoh_handoffs'))} (handoff_id, from_actor, to_actor, scope, context_pack, acceptance, open_questions, state, accepted_at, closed_at)
          values (${r.handoff_id}, ${r.from_actor}, ${r.to_actor}, ${r.scope}, ${r.context_pack}, ${r.acceptance}, ${r.open_questions}, ${r.state}, ${r.accepted_at}, ${r.closed_at})
          on conflict (handoff_id) do nothing`;
      }
    });
    console.log(`import completed into schema ${SCHEMA}`);
  })().catch((err) => {
    console.error('ERROR', err && (err.message || err));
    process.exitCode = 1;
  }).finally(async () => {
    try {
      await sql.end();
    } catch (err) {
      // ignore close errors
    }
  });
}

main();