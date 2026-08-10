#!/usr/bin/env node
/* EWOH Scheduler V2 multi-tenant isolation E2E (Task 3, ADR-004).
 *
 * Verifies the DB-level tenancy boundary of the 11 Scheduler V2 runtime tables
 * against a real PostgreSQL (migrations standalone_025 + standalone_028 applied):
 *
 *   - 8 org-scoped tables (RLS ON, policy FOR service_role reading
 *     app.current_org_id with app.primary_org_id fallback): org A rows are
 *     invisible to org B — SELECT/UPDATE/DELETE all hit 0 rows.
 *   - Without the GUC only global rows (org_id IS NULL) are visible on RLS tables.
 *   - 3 global tables (ewoh_outbox / ewoh_world_state_snapshot /
 *     ewoh_assignment_event) stay readable across orgs by design
 *     (GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP — RLS stays OFF).
 *   - ewoh_assignment_event.org_id is derived by trg_assignment_event_derive_org
 *     (standalone_028) from the owning plan_assignment/plan, and the DB-level
 *     derived-ownership invariant holds (0 mismatches).
 *
 * The connection role MUST be a non-superuser member of service_role (e.g. the
 * ewoh_api runtime role): superusers and BYPASSRLS roles bypass RLS, which would
 * make the isolation assertions vacuous — the script refuses to run as such a role.
 *
 * Env:
 *   EWOH_DATABASE_URL (or EWOH_RUNTIME_DATABASE_URL) — required.
 *   EWOH_SCHEMA — defaults to public.
 *
 * Output contract (honest-gate convention):
 *   - Each assertion prints `PASS/FAIL  <name>`; on success the script prints a
 *     machine-readable `RESULT {json}` summary + `PASS` and exits 0.
 *   - Any assertion failure prints `RESULT {json}` + `FAIL` and exits non-zero.
 *   - EWOH_DATABASE_URL unset -> `::notice::BLOCKED_BY_ENVIRONMENT: ...`, exit 0
 *     (never faked PASS; matches scripts/verify-migration-prod.mjs).
 *   - PostgreSQL unreachable -> BLOCKED_BY_ENVIRONMENT, exit 0.
 *   - Migrations not applied / RLS misconfigured -> real FAILURE, exit non-zero.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

const SCHEMA = process.env.EWOH_SCHEMA || 'public';
const url = process.env.EWOH_DATABASE_URL || process.env.EWOH_RUNTIME_DATABASE_URL;

let postgres = null;
try {
  postgres = requireFromApp('postgres');
} catch {
  postgres = null; // handled below as BLOCKED_BY_ENVIRONMENT
}

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
  console.error(`Invalid EWOH_SCHEMA: ${SCHEMA}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Test identity (org-a / org-b / global rows); keys are script-generated.
// ---------------------------------------------------------------------------
const runId = randomUUID().slice(0, 8);
const ORG_A = `org-a-${runId}`;
const ORG_B = `org-b-${runId}`;
const RUN_A = `run-a-${runId}`;
const RUN_GLOBAL = `run-global-${runId}`;
const PLAN_A = `plan-a-${runId}`;
const ASSIGN_A = `assign-a-${runId}`;
const FB_A = `fb-a-${runId}`;
const TRIG_A = `trig-a-${runId}`;
const CSTR_A = `cstr-a-${runId}`;
const RESV_A = `resv-a-${runId}`;
const EVT_A = `evt-a-${runId}`;
const OB_A = `ob-a-${runId}`;
const SNAP_A = `snap-a-${runId}`;
const ENTITY_A = `task-a-${runId}`;
const PERSON_A = `person-a-${runId}`;

/** 8 org-scoped tables covered by standalone_025 RLS (scheduler_<table>_org_isolation). */
const TENANT_TABLES = [
  'ewoh_scheduling_run',
  'ewoh_schedule_plan',
  'ewoh_scheduling_plan_assignment',
  'ewoh_resource_reservation',
  'ewoh_scheduling_policy',
  'ewoh_scheduling_feedback',
  'ewoh_replan_trigger',
  'ewoh_scheduling_constraint',
];

/** 3 global tables kept non-RLS by design (025 header + ADR-004). */
const GLOBAL_TABLES = [
  'ewoh_outbox',
  'ewoh_world_state_snapshot',
  'ewoh_assignment_event',
];

const ALL_TABLES = [...TENANT_TABLES, ...GLOBAL_TABLES];

/** Per-table negative-assertion cases: org-b must not see/change org-a rows. */
const TENANT_CASES = [
  { table: 'ewoh_scheduling_run', keyCol: 'run_id', key: RUN_A, setCol: 'status', setVal: 'cancelled' },
  { table: 'ewoh_schedule_plan', keyCol: 'plan_id', key: PLAN_A, setCol: 'status', setVal: 'cancelled' },
  { table: 'ewoh_scheduling_plan_assignment', keyCol: 'assignment_id', key: ASSIGN_A, setCol: 'status', setVal: 'cancelled' },
  { table: 'ewoh_resource_reservation', keyCol: 'reservation_id', key: RESV_A, setCol: 'status', setVal: 'released' },
  { table: 'ewoh_scheduling_policy', keyCol: 'config_version', key: 1, setCol: 'active', setVal: false },
  { table: 'ewoh_scheduling_feedback', keyCol: 'feedback_id', key: FB_A, setCol: 'accepted', setVal: true },
  { table: 'ewoh_replan_trigger', keyCol: 'trigger_key', key: TRIG_A, setCol: 'status', setVal: 'pending' },
  { table: 'ewoh_scheduling_constraint', keyCol: 'constraint_id', key: CSTR_A, setCol: 'active', setVal: false },
];

let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const q = (t) => `${SCHEMA}.${t}`;

function blocked(reason) {
  console.error(`::notice::BLOCKED_BY_ENVIRONMENT: ${reason}`);
  console.log(`RESULT ${JSON.stringify({
    gate: 'scheduler-multitenant', status: 'BLOCKED_BY_ENVIRONMENT', checkedAt: new Date().toISOString(),
    reason, checks, failures,
  })}`);
}

async function main() {
  if (!postgres) {
    blocked('postgres driver unavailable (ewoh-spark-app node_modules not installed)');
    return 0;
  }
  if (!url) {
    blocked(
      'EWOH_DATABASE_URL (or EWOH_RUNTIME_DATABASE_URL) is required — a migrated real PostgreSQL ' +
        'with standalone_025 + standalone_028 applied, connecting as a non-superuser service_role member (e.g. ewoh_api)',
    );
    return 0;
  }

  // Three independent connections = three independent tenants/GUC contexts.
  const sqlA = postgres(url, { max: 1, idle_timeout: 30_000, onnotice: () => {} }); // org-a
  const sqlB = postgres(url, { max: 1, idle_timeout: 30_000, onnotice: () => {} }); // org-b
  const sqlG = postgres(url, { max: 1, idle_timeout: 30_000, onnotice: () => {} }); // no GUC

  const endAll = async () => {
    for (const s of [sqlA, sqlB, sqlG]) {
      try { await s.end(); } catch { /* ignore */ }
    }
  };

  // Best-effort cleanup of rows created by this script (RLS tables via org-a conn,
  // scoped by org_id so only our rows are touched).
  const cleanup = async () => {
    try {
      for (const c of TENANT_CASES) {
        await sqlA.unsafe(
          `delete from ${SCHEMA}.${c.table} where ${c.keyCol} = $1 and org_id = $2`,
          [c.key, ORG_A],
        );
      }
      await sqlG.unsafe(`delete from ${SCHEMA}.ewoh_scheduling_run where run_id = $1`, [RUN_GLOBAL]);
      await sqlG.unsafe(`delete from ${SCHEMA}.ewoh_outbox where event_id = $1`, [OB_A]);
      await sqlG.unsafe(`delete from ${SCHEMA}.ewoh_world_state_snapshot where snapshot_version = $1`, [SNAP_A]);
      await sqlG.unsafe(`delete from ${SCHEMA}.ewoh_assignment_event where event_id = $1`, [EVT_A]);
    } catch (e) {
      console.log(`  (cleanup warning: ${e && (e.message || e)})`);
    }
  };

  try {
    // --- connectivity probe: unreachable DB = BLOCKED, never FAILED/PASSED. ---
    try {
      await sqlA`select 1`;
    } catch (err) {
      blocked(`PostgreSQL unreachable: ${err && (err.message || err)}`);
      await endAll();
      return 0;
    }

    console.log(`EWOH Scheduler V2 multi-tenant isolation E2E | schema=${SCHEMA} | org-a=${ORG_A} org-b=${ORG_B}`);

    // --- 0) Refuse vacuous RLS: superuser / BYPASSRLS bypass RLS. ---
    {
      const [me] = await sqlA.unsafe(`
        select current_user as u,
          (select rolsuper from pg_roles where rolname = current_user) as super,
          (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls
      `);
      check(
        'connection role is non-superuser without BYPASSRLS (RLS assertions are meaningful)',
        me && !me.super && !me.bypassrls,
        `current_user=${me && me.u}`,
      );
      if (me && (me.super || me.bypassrls)) {
        // RLS would be bypassed -> every isolation assertion is vacuous; stop here.
        console.error('FAIL: superuser/BYPASSRLS role bypasses RLS; connect as a non-superuser service_role member (e.g. ewoh_api).');
        await cleanup();
        await endAll();
        return 1;
      }
    }

    // --- 1) Migrations applied: all 11 runtime tables must exist. ---
    {
      const [present] = await sqlA.unsafe(
        `select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = any($2)`,
        [SCHEMA, ALL_TABLES],
      );
      if (present.n !== ALL_TABLES.length) {
        const have = await sqlA.unsafe(
          `select table_name from information_schema.tables where table_schema = $1 and table_name = any($2)`,
          [SCHEMA, ALL_TABLES],
        );
        const haveSet = new Set(have.map((r) => r.table_name));
        const missing = ALL_TABLES.filter((t) => !haveSet.has(t));
        console.error(`FAIL: scheduler runtime tables missing — migrations (006..028) not applied: ${missing.join(', ')}`);
        await endAll();
        return 1;
      }
      check('all 11 scheduler V2 runtime tables present (migrations applied)', true, `schema=${SCHEMA}`);
    }

    // --- 2) RLS configuration: 8 tenants ON, 3 globals OFF, policies FOR service_role. ---
    {
      const rows = await sqlA.unsafe(
        `select c.relname as table_name, c.relrowsecurity as enabled
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = any($2)`,
        [SCHEMA, ALL_TABLES],
      );
      const map = new Map(rows.map((r) => [r.table_name, r.enabled]));
      for (const t of TENANT_TABLES) {
        check(`RLS enabled on ${t}`, map.get(t) === true, `relrowsecurity=${map.get(t)}`);
      }
      for (const t of GLOBAL_TABLES) {
        check(`RLS stays OFF on ${t} (GLOBAL_SHARED/DERIVED)`, map.get(t) === false, `relrowsecurity=${map.get(t)}`);
      }
    }
    {
      const policies = await sqlA.unsafe(
        `select tablename, policyname, roles from pg_policies
          where schemaname = $1 and policyname like '%org_isolation'`,
        [SCHEMA],
      );
      check('8 scheduler org-isolation policies present', policies.length === 8, `count=${policies.length}`);
      const allForService = policies.every(
        (p) => Array.isArray(p.roles) && p.roles.includes('service_role'),
      );
      check('every org-isolation policy is FOR service_role', allForService);
    }

    // --- 3) Data setup as org-a (GUC app.current_org_id = org-a). ---
    await sqlA`select set_config('app.current_org_id', ${ORG_A}, false)`;
    await sqlB`select set_config('app.current_org_id', ${ORG_B}, false)`;

    await sqlA`insert into ${sqlA(q('ewoh_scheduling_run'))} (run_id, org_id, trigger_type, status) values (${RUN_A}, ${ORG_A}, 'manual', 'queued') returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_schedule_plan'))} (plan_id, plan_name, strategy, org_id) values (${PLAN_A}, 'E2E Plan A', 'balanced', ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_scheduling_plan_assignment'))} (assignment_id, plan_id, org_id) values (${ASSIGN_A}, ${PLAN_A}, ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_scheduling_policy'))} (config_version, config_json, org_id) values (1, '{}'::jsonb, ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_scheduling_feedback'))} (feedback_id, plan_id, org_id) values (${FB_A}, ${PLAN_A}, ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_replan_trigger'))} (trigger_key, org_id, trigger_type, entity_id) values (${TRIG_A}, ${ORG_A}, 'manual', ${ENTITY_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_scheduling_constraint'))} (constraint_id, type, plan_id, org_id) values (${CSTR_A}, 'LOCKED_TIME', ${PLAN_A}, ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_resource_reservation'))} (reservation_id, resource_type, resource_id, start_ms, end_ms, org_id) values (${RESV_A}, 'person', ${PERSON_A}, 0, 1000, ${ORG_A}) returning id`;
    // Global tables (RLS off); assignment_event org_id will be derived by the 028 trigger.
    await sqlA`insert into ${sqlA(q('ewoh_assignment_event'))} (event_id, assignment_id, actor) values (${EVT_A}, ${ASSIGN_A}, 'e2e') returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_outbox'))} (event_id, event_type, entity_id, org_id) values (${OB_A}, 'e2e.test', ${ENTITY_A}, ${ORG_A}) returning id`;
    await sqlA`insert into ${sqlA(q('ewoh_world_state_snapshot'))} (snapshot_version, snapshot_json) values (${SNAP_A}, '{}'::jsonb) returning id`;
    // A global row (org_id NULL) on an RLS table, inserted WITHOUT the GUC.
    await sqlG`insert into ${sqlG(q('ewoh_scheduling_run'))} (run_id, org_id, trigger_type, status) values (${RUN_GLOBAL}, null, 'manual', 'queued') returning id`;
    check('org-a data setup complete (8 RLS tables + 3 global tables + 1 global run row)', true);

    // --- 4) Org-b negative assertions on all 8 RLS tables (SELECT/UPDATE/DELETE). ---
    for (const c of TENANT_CASES) {
      const [sel] = await sqlB.unsafe(
        `select count(*)::int as n from ${SCHEMA}.${c.table} where ${c.keyCol} = $1`,
        [c.key],
      );
      check(`org-b SELECT sees 0 org-a rows in ${c.table}`, sel.n === 0, `count=${sel.n}`);
      const upd = await sqlB.unsafe(
        `update ${SCHEMA}.${c.table} set ${c.setCol} = $1 where ${c.keyCol} = $2 returning id`,
        [c.setVal, c.key],
      );
      check(`org-b UPDATE affects 0 rows in ${c.table}`, upd.length === 0, `affected=${upd.length}`);
      const del = await sqlB.unsafe(
        `delete from ${SCHEMA}.${c.table} where ${c.keyCol} = $1 returning id`,
        [c.key],
      );
      check(`org-b DELETE affects 0 rows in ${c.table}`, del.length === 0, `affected=${del.length}`);
    }

    // --- 5) org-a data untouched by org-b's negative attempts. ---
    {
      const [chk] = await sqlA.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_scheduling_run where run_id = $1 and org_id = $2`,
        [RUN_A, ORG_A],
      );
      check('org-a run row still present with org_id intact', chk.n === 1, `count=${chk.n}`);
    }

    // --- 6) No-GUC connection: only global (org_id IS NULL) rows on RLS tables. ---
    {
      const [g1] = await sqlG.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_scheduling_run where run_id = $1`,
        [RUN_A],
      );
      check('no-GUC cannot SELECT org-a run (RLS requires current_org_id)', g1.n === 0, `count=${g1.n}`);
      const [g2] = await sqlG.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_scheduling_run where run_id = $1`,
        [RUN_GLOBAL],
      );
      check('no-GUC sees global run row (org_id IS NULL branch)', g2.n === 1, `count=${g2.n}`);
      const [g3] = await sqlG.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_outbox where event_id = $1`,
        [OB_A],
      );
      check('no-GUC reads org-a outbox row (GLOBAL_SHARED)', g3.n === 1, `count=${g3.n}`);
      const [g4] = await sqlG.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_world_state_snapshot where snapshot_version = $1`,
        [SNAP_A],
      );
      check('no-GUC reads snapshot row (GLOBAL_SHARED)', g4.n === 1, `count=${g4.n}`);
      const [g5] = await sqlG.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_assignment_event where event_id = $1`,
        [EVT_A],
      );
      check('no-GUC reads assignment_event row (DERIVED, RLS off by design)', g5.n === 1, `count=${g5.n}`);
    }

    // --- 7) Org-b cross-org readability of the 3 global tables (by design). ---
    {
      const [b1] = await sqlB.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_outbox where event_id = $1`,
        [OB_A],
      );
      check('org-b reads org-a outbox row (GLOBAL_SHARED, SSE replay is cross-org by design)', b1.n === 1, `count=${b1.n}`);
      const [b2] = await sqlB.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_world_state_snapshot where snapshot_version = $1`,
        [SNAP_A],
      );
      check('org-b reads snapshot row (GLOBAL_SHARED, snapshotVersion global key)', b2.n === 1, `count=${b2.n}`);
      const [b3] = await sqlB.unsafe(
        `select count(*)::int as n from ${SCHEMA}.ewoh_assignment_event where event_id = $1`,
        [EVT_A],
      );
      check('org-b reads assignment_event row (DERIVED_TENANT_OWNERSHIP, audit stream global)', b3.n === 1, `count=${b3.n}`);
    }

    // --- 8) Derived ownership (standalone_028): trigger populated org_id from plan. ---
    {
      const [evt] = await sqlA.unsafe(
        `select org_id from ${SCHEMA}.ewoh_assignment_event where event_id = $1`,
        [EVT_A],
      );
      check(
        '028 trigger derived org_id on assignment_event from owning assignment/plan',
        evt && evt.org_id === ORG_A,
        `org_id=${evt && evt.org_id}`,
      );
      const [inv] = await sqlA.unsafe(`
        select count(*)::int as n
          from ${SCHEMA}.ewoh_assignment_event evt
          join ${SCHEMA}.ewoh_scheduling_plan_assignment pa on pa.assignment_id = evt.assignment_id
          left join ${SCHEMA}.ewoh_schedule_plan p on p.plan_id = pa.plan_id
         where evt.org_id is not null and evt.org_id <> coalesce(pa.org_id, p.org_id)
      `);
      check('derived-ownership DB invariant holds (0 mismatches)', inv.n === 0, `mismatches=${inv.n}`);
    }

    await cleanup();
    await endAll();

    const status = failures > 0 ? 'FAIL' : 'PASS';
    console.log(`RESULT ${JSON.stringify({
      gate: 'scheduler-multitenant', status, checkedAt: new Date().toISOString(),
      checks, failures, orgA: ORG_A, orgB: ORG_B, schema: SCHEMA,
    })}`);
    console.log(failures > 0 ? `FAIL: ${failures}/${checks} assertions failed` : 'PASS');
    return failures > 0 ? 1 : 0;
  } catch (err) {
    console.error('FAIL: ' + (err && (err.stack || err.message || err)));
    await cleanup();
    await endAll();
    return 1;
  }
}

main().then((code) => { process.exitCode = code; });
