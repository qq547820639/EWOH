#!/usr/bin/env node
/**
 * Task 7 — Deterministic large-data seeder for the Role Workbench.
 *
 * Inserts a reproducible dataset across org-a / org-b / org-c into the workbench
 * source tables (ewoh_schedule_task, ewoh_schedule_task_step, ewoh_event,
 * ewoh_spatial_entity, ewoh_resource_binding, ewoh_world_state) plus the
 * workbench persistence tables (saved_views, workbench_export_tasks).
 *
 * Determinism: every row id, org assignment, status, timestamp and JSON payload
 * is derived from a seeded PRNG (mulberry32) with a fixed default seed, so two
 * runs with the same --scale produce byte-identical data. Results are therefore
 * reproducible and comparable across runs / environments.
 *
 * Data scale is expressed as the total number of ewoh_schedule_task rows (`N`).
 * Steps (3/task), events (N), spatial entities (N/10), resource bindings (N/10)
 * and world-state rows (N/10) are generated as fixed multiples of N.
 *
 * Usage:
 *   node scripts/perf/seed-workbench-data.js --scale 10000
 *   node scripts/perf/seed-workbench-data.js --scale 100000
 *   node scripts/perf/seed-workbench-data.js --scale 1000000 --url "$PERF_DATABASE_URL"
 *
 * Env: PERF_DATABASE_URL (falls back to EWOH_E2E_OWNER_DATABASE_URL, then
 * EWOH_DATABASE_URL, then DATABASE_URL). Must be an owner/superuser URL so it
 * bypasses RLS on the workbench tables.
 */
'use strict';

const { createRequire } = require('module');
const path = require('path');

const appDir = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));
const postgres = requireFromApp('postgres');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — fixed seed => reproducible data.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORGS = ['org-a', 'org-b', 'org-c'];
// Deterministic org split: org-a 60%, org-b 30%, org-c 10%.
const ORG_BUCKET = [];
for (let i = 0; i < 6; i += 1) ORG_BUCKET.push('org-a');
for (let i = 0; i < 3; i += 1) ORG_BUCKET.push('org-b');
ORG_BUCKET.push('org-c'); // 10%

const TASK_STATUSES = ['draft', 'pending', 'in_progress', 'paused', 'completed', 'cancelled'];
const STEP_STATUSES = ['pending', 'in_progress', 'paused', 'completed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const SOURCES = ['manual', 'scheduler', 'ai', 'erp'];
const ENTITY_STATUSES = ['active', 'idle', 'fault'];
const BINDING_TYPES = ['material', 'tool', 'device', 'space'];
const DEFECT_CODES = ['DC-SOLDER', 'DC-ALIGN', 'DC-TORQUE', 'DC-SURFACE', 'DC-VIBE', 'DC-CLEAN', 'DC-UNKNOWN'];

// Reference "now-ish" timestamp so the deterministic window stays fresh.
const BASE_MS = Date.now();

function iso(ms) {
  return new Date(ms).toISOString();
}

function pickOrg(i) {
  return ORG_BUCKET[i % ORG_BUCKET.length];
}

function pickStepStatus(i, k) {
  return STEP_STATUSES[(i * 1 + k * 3) % STEP_STATUSES.length];
}

function isDelayed(i) {
  // ~50% of tasks get a plan_end in the past (delayedOrders/orderDeliveryRisk source).
  return i % 2 === 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { scale: 10000, seed: 20260806, truncate: false, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scale') args.scale = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--truncate') args.truncate = true;
    else if (a === '--url') args.url = argv[++i];
  }
  if (!Number.isInteger(args.scale) || args.scale <= 0) {
    throw new Error('--scale must be a positive integer (e.g. 10000, 100000, 1000000)');
  }
  return args;
}

function resolveUrl() {
  return (
    process.env.PERF_DATABASE_URL ||
    process.env.EWOH_E2E_OWNER_DATABASE_URL ||
    process.env.EWOH_DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();
}

// ---------------------------------------------------------------------------
// Row builders (deterministic)
// ---------------------------------------------------------------------------
function buildTaskRows(rand, scale) {
  const rows = [];
  for (let i = 0; i < scale; i += 1) {
    const org = pickOrg(i);
    const status = TASK_STATUSES[i % TASK_STATUSES.length];
    const delayed = isDelayed(i);
    const planEnd = delayed
      ? iso(BASE_MS - (i % 90) * 24 * 3600 * 1000 - rand() * 3600 * 1000)
      : iso(BASE_MS + (i % 90) * 24 * 3600 * 1000 + rand() * 3600 * 1000);
    const planStart = iso(new Date(planEnd).getTime() - 2 * 24 * 3600 * 1000);
    rows.push([
      `st-${scale}-${i}`, // schedule_task_id
      `tpl-${i % 50}`, // template_id
      `order-${scale}-${i}`, // title
      `deterministic description ${i}`, // description
      status,
      PRIORITIES[i % PRIORITIES.length],
      SOURCES[i % SOURCES.length],
      planStart,
      planEnd,
      i % 5 === 0 ? iso(BASE_MS - (i % 30) * 3600 * 1000) : null, // actual_start
      status === 'completed' ? iso(BASE_MS - (i % 30) * 3600 * 1000) : null, // actual_end
      i % 20 === 0 ? `parent-${i % 5}` : null, // parent_task_id
      null, // approval_id
      null, // suggestion_id
      null, // session_id
      false, // is_simulation
      (i % 101), // progress
      null, // deleted_at
      org, // org_id
      new Date(planStart), // _created_at
      null, // _created_by
      new Date(planStart), // _updated_at
      null, // _updated_by
    ]);
  }
  return rows;
}

function buildStepRows(rand, scale) {
  const rows = [];
  const stepsPerTask = 3;
  for (let i = 0; i < scale; i += 1) {
    const org = pickOrg(i);
    for (let k = 0; k < stepsPerTask; k += 1) {
      const status = pickStepStatus(i, k);
      const resultJson =
        k === 2
          ? JSON.stringify({
              exception: i % 8 === 0 ? 'torque-out-of-range' : '',
              sop: { signatures: i % 4 === 0 ? [] : ['signed'] },
            })
          : null;
      rows.push([
        `step-${scale}-${i}-${k}`, // step_id
        `st-${scale}-${i}`, // schedule_task_id
        k + 1, // step_no
        `工序-${i}-${k}`, // name
        `instruction ${i}-${k}`, // instruction
        status,
        iso(BASE_MS - (i % 90) * 24 * 3600 * 1000), // planned_start
        iso(BASE_MS - (i % 90) * 24 * 3600 * 1000 + 2 * 3600 * 1000), // planned_end
        status === 'in_progress' || status === 'completed'
          ? iso(BASE_MS - (i % 90) * 24 * 3600 * 1000)
          : null, // actual_start
        status === 'completed' ? iso(BASE_MS - (i % 90) * 24 * 3600 * 1000 + 3600 * 1000) : null, // actual_end
        `p-${org}-${(i * stepsPerTask + k) % 40}`, // assigned_person_id
        null, // assigned_device_id
        null, // spatial_entity_id
        (i * stepsPerTask + k) % 101, // progress
        resultJson, // result_json
        null, // parent_step_id
        org, // org_id
        new Date(BASE_MS - (i % 90) * 24 * 3600 * 1000), // _created_at
        null, // _created_by
        new Date(BASE_MS - (i % 90) * 24 * 3600 * 1000), // _updated_at
        null, // _updated_by
      ]);
    }
  }
  void rand;
  return rows;
}

function buildEventRows(rand, scale) {
  const rows = [];
  for (let i = 0; i < scale; i += 1) {
    const org = pickOrg(i);
    const quality = i % 3 < 2;
    const status = i % 4 < 3 ? 'open' : 'closed';
    const evidence = quality
      ? JSON.stringify({
          result: i % 5 === 0 ? 'fail' : 'pass',
          defectCode: DEFECT_CODES[i % DEFECT_CODES.length],
        })
      : null;
    rows.push([
      `evt-${scale}-${i}`, // event_id
      `dev-${org}-${i % (scale / 10)}`, // device_id
      `code-${i % 20}`, // event_code
      quality ? 'quality' : 'safety', // event_type
      i % 3 === 0 ? 'high' : 'medium', // severity
      `event-${scale}-${i}`, // title
      status,
      iso(BASE_MS - (i % 90) * 24 * 3600 * 1000), // created_at
      null, // handler_action
      'simulated', // source_type
      null, // trigger_record_id
      evidence, // evidence_json
      org, // org_id
      new Date(BASE_MS - (i % 90) * 24 * 3600 * 1000), // _updated_at
    ]);
  }
  void rand;
  return rows;
}

function buildSpatialRows(rand, scale) {
  const count = Math.max(1, Math.floor(scale / 10));
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const org = pickOrg(i);
    rows.push([
      `ent-${scale}-${i}`, // entity_id
      i % 5 === 0 ? 'area' : 'device', // entity_type
      i === 0 ? null : `ent-${scale}-${i - 1}`, // parent_id
      `entity-${scale}-${i}`, // name
      Number((rand() * 100).toFixed(2)), // x
      Number((rand() * 100).toFixed(2)), // y
      Number((rand() * 360).toFixed(2)), // yaw
      ENTITY_STATUSES[i % ENTITY_STATUSES.length], // status
      'seed', // source_type
      0.9 + rand() * 0.1, // confidence
      org, // org_id
    ]);
  }
  return rows;
}

function buildBindingRows(rand, scale) {
  const count = Math.max(1, Math.floor(scale / 10));
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const org = pickOrg(i);
    rows.push([
      `bind-${scale}-${i}`, // binding_id
      BINDING_TYPES[i % BINDING_TYPES.length], // binding_type
      'material', // resource_type
      `res-${i % 100}`, // resource_id
      'task', // target_type
      `st-${scale}-${i % scale}`, // target_id
      iso(BASE_MS - (i % 90) * 24 * 3600 * 1000), // start_time
      i % 3 === 0 ? iso(BASE_MS + (i % 30) * 3600 * 1000) : null, // end_time
      null, // reason
      'active', // status
      `p-${org}-${i % 40}`, // operator_id
      '10.0000', // quantity
      org, // org_id
    ]);
  }
  void rand;
  return rows;
}

function buildWorldStateRows(rand, scale) {
  const count = Math.max(1, Math.floor(scale / 10));
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const org = pickOrg(i);
    rows.push([
      `ws-${scale}-${i}`, // entity_id
      JSON.stringify({ temperatureC: Number((20 + rand() * 40).toFixed(1)), ok: i % 9 !== 0 }), // state_json
      new Date(BASE_MS - (i % 90) * 24 * 3600 * 1000), // ts
      org, // org_id
    ]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Batch insert helper (postgres multi-row array insert)
// ---------------------------------------------------------------------------
async function insertRows(sql, table, columns, rows, batchSize) {
  const cols = columns.join(',');
  const total = rows.length;
  const widths = columns.length;
  let inserted = 0;
  for (let start = 0; start < total; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const placeholders = [];
    const params = [];
    batch.forEach((row, ri) => {
      const rowPlaceholders = [];
      row.forEach((value, ci) => {
        rowPlaceholders.push(`$${ri * widths + ci + 1}`);
        params.push(value);
      });
      placeholders.push(`(${rowPlaceholders.join(',')})`);
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      await sql.unsafe(
        `insert into ${table} (${cols}) values ${placeholders.join(',')}`,
        params,
      );
    } catch (err) {
      throw new Error(`insert failed on ${table} at row ${start}: ${err.message}`);
    }
    inserted += batch.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${total}`);
  }
  process.stdout.write('\n');
  return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || resolveUrl();
  if (!url) {
    console.error(
      'BLOCKED_BY_ENVIRONMENT: no database URL. Set PERF_DATABASE_URL (or EWOH_E2E_OWNER_DATABASE_URL / EWOH_DATABASE_URL / DATABASE_URL).',
    );
    process.exit(2);
  }

  const rand = mulberry32(args.seed);
  const scale = args.scale;

  const sql = postgres(url, { max: 4, onnotice: () => {}, prepare: false });
  const batchSize = 2000;

  try {
    await sql.unsafe('select 1 as ready');
    console.log(`Seeding scale=${scale} seed=${args.seed} orgs=${ORGS.join(',')}`);

    if (args.truncate) {
      console.log('Truncating workbench source tables...');
      await sql.unsafe(`
        truncate table
          public.ewoh_schedule_task,
          public.ewoh_schedule_task_step,
          public.ewoh_event,
          public.ewoh_spatial_entity,
          public.ewoh_resource_binding,
          public.ewoh_world_state,
          public.saved_views,
          public.workbench_export_tasks
        restart identity cascade`);
      console.log('Truncated.');
    }

    const taskRows = buildTaskRows(rand, scale);
    const stepRows = buildStepRows(rand, scale);
    const eventRows = buildEventRows(rand, scale);
    const spatialRows = buildSpatialRows(rand, scale);
    const bindingRows = buildBindingRows(rand, scale);
    const worldRows = buildWorldStateRows(rand, scale);

    console.log(`Inserting ${taskRows.length} schedule_task rows...`);
    await insertRows(sql, 'public.ewoh_schedule_task', [
      'schedule_task_id', 'template_id', 'title', 'description', 'status', 'priority', 'source',
      'plan_start', 'plan_end', 'actual_start', 'actual_end', 'parent_task_id',
      'approval_id', 'suggestion_id', 'session_id', 'is_simulation', 'progress',
      'deleted_at', 'org_id', '_created_at', '_created_by', '_updated_at', '_updated_by',
    ], taskRows, batchSize);

    console.log(`Inserting ${stepRows.length} schedule_task_step rows...`);
    await insertRows(sql, 'public.ewoh_schedule_task_step', [
      'step_id', 'schedule_task_id', 'step_no', 'name', 'instruction', 'status',
      'planned_start', 'planned_end', 'actual_start', 'actual_end', 'assigned_person_id',
      'assigned_device_id', 'spatial_entity_id', 'progress', 'result_json', 'parent_step_id',
      'org_id', '_created_at', '_created_by', '_updated_at', '_updated_by',
    ], stepRows, batchSize);

    console.log(`Inserting ${eventRows.length} event rows...`);
    await insertRows(sql, 'public.ewoh_event', [
      'event_id', 'device_id', 'event_code', 'event_type', 'severity', 'title', 'status',
      'created_at', 'handler_action', 'source_type', 'trigger_record_id', 'evidence_json',
      'org_id', '_updated_at',
    ], eventRows, batchSize);

    console.log(`Inserting ${spatialRows.length} spatial_entity rows...`);
    await insertRows(sql, 'public.ewoh_spatial_entity', [
      'entity_id', 'entity_type', 'parent_id', 'name', 'x', 'y', 'yaw', 'status', 'source_type', 'confidence', 'org_id',
    ], spatialRows, batchSize);

    console.log(`Inserting ${bindingRows.length} resource_binding rows...`);
    await insertRows(sql, 'public.ewoh_resource_binding', [
      'binding_id', 'binding_type', 'resource_type', 'resource_id', 'target_type', 'target_id',
      'start_time', 'end_time', 'reason', 'status', 'operator_id', 'quantity', 'org_id',
    ], bindingRows, batchSize);

    console.log(`Inserting ${worldRows.length} world_state rows...`);
    await insertRows(sql, 'public.ewoh_world_state', [
      'entity_id', 'state_json', 'ts', 'org_id',
    ], worldRows, batchSize);

    // Verify scale.
    const count = await sql.unsafe('select count(*)::int as c from public.ewoh_schedule_task');
    const total = count[0].c;
    const byOrg = await sql.unsafe(
      `select org_id, count(*)::int as c from public.ewoh_schedule_task group by org_id order by org_id`,
    );
    console.log(`\nSeeded schedule_task rows: ${total}`);
    console.log('By org:');
    for (const row of byOrg) console.log(`  ${JSON.stringify(row)}`);

    if (total < scale) {
      console.error(`VERIFY FAILED: expected at least ${scale} schedule_task rows, got ${total}`);
      process.exitCode = 1;
    } else {
      console.log('VERIFY OK: scale requirement met.');
    }
  } catch (err) {
    console.error('SEED ERROR:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});