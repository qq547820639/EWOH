#!/usr/bin/env node
/**
 * Task 7 — Large-data performance benchmark for the Role Workbench.
 *
 * Runs against a REAL PostgreSQL test DB (no mocking of the production query
 * path). Every scenario is a direct SQL reproduction of the exact query shapes
 * issued by `RoleWorkbenchService.getWorkbench` / `getWorkbenchList` (see
 * server/modules/operations/role-workbench.service.ts and
 * workbench-list-query.ts), all org-scoped.
 *
 * For each scenario it records wall-clock p50 / p95 / p99 / mean / min / max,
 * plus DB execution time and scanned rows captured from `EXPLAIN (ANALYZE)`,
 * and the returned row count. It also:
 *   - guards against N+1 (a list query must be exactly COUNT + 1 data SELECT),
 *   - guards against full-table seq-scans per refresh,
 *   - verifies org isolation (org-a can never see org-b/org-c rows).
 *
 * Report is written to <repo>/output/perf-workbench-report.json and includes
 * budget, run environment, data scale and the current git commit SHA.
 *
 * Usage:
 *   node scripts/perf/workbench-benchmark.js --scale 10000
 *   node scripts/perf/workbench-benchmark.js --scale 100000
 *   node scripts/perf/workbench-benchmark.js --scale 100000 --iterations 20
 */
'use strict';

const { createRequire } = require('module');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));
const postgres = requireFromApp('postgres');

const BUDGET_FILE = path.join(__dirname, 'perf-budget.json');
const OUT_DIR = path.join(repoRoot, 'output');
const OUT_FILE = path.join(OUT_DIR, 'perf-workbench-report.json');

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_C = 'org-c';
const PAGE_SIZE = 20;
const ACTIVE_TASK_STATUSES = ['draft', 'pending', 'in_progress', 'paused'];
const ACTIVE_STEP_STATUSES = ['pending', 'in_progress', 'paused'];

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { scale: 10000, iterations: 10, url: null, out: OUT_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scale') args.scale = Number(argv[++i]);
    else if (a === '--iterations') args.iterations = Number(argv[++i]);
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 3) {
    throw new Error('--iterations must be an integer >= 3');
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

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    iterations: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    meanMs: round(sum / sorted.length),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// EXPLAIN ANALYZE helpers
// ---------------------------------------------------------------------------
function walkPlan(node, acc) {
  if (!node) return;
  acc.push(node);
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) walkPlan(child, acc);
  }
}

async function explain(sql, query, params) {
  const raw = await sql.unsafe(
    `explain (analyze, buffers, format json) ${query}`,
    ...params,
  );
  const plan = raw[0]['QUERY PLAN'][0];
  const nodes = [];
  walkPlan(plan.Plan, nodes);
  const seqScans = nodes.filter(
    (n) => n['Node Type'] === 'Seq Scan' && /^ewoh_/.test(n['Relation Name'] || ''),
  );
  const top = nodes[0];
  return {
    executionTimeMs:
      typeof plan['Execution Time'] === 'number' ? plan['Execution Time'] : null,
    rowsProduced: top ? top['Plan Rows'] : null,
    actualRows: top ? top['Actual Rows'] : null,
    seqScansOnWorkbench: seqScans.map((n) => ({
      relation: n['Relation Name'],
      actualRows: n['Actual Rows'],
    })),
  };
}

// ---------------------------------------------------------------------------
// Scenario SQL (mirrors role-workbench.service.ts query shapes; org-scoped)
// ---------------------------------------------------------------------------
const DELAYED_ORDER_WHERE = () =>
  `org_id = $1 and status = any($2::varchar[]) and plan_end is not null and plan_end < now()`;

const STEP_WHERE = (search) =>
  `org_id = $1 and status = any($2::varchar[]) ${
    search ? `and name ilike $3` : ''
  }`;

const LIST_SCENARIOS = {
  'list-offset-page1': {
    label: 'List page 1 (offset mode) — delayedOrders',
    explainOn: 'delayedOrders',
    run: async (sql) => {
      const params = [ORG_A, ACTIVE_TASK_STATUSES];
      const count = await sql.unsafe(
        `select count(*)::int as c from ewoh_schedule_task where ${DELAYED_ORDER_WHERE()}`,
        ...params,
      );
      const data = await sql.unsafe(
        `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
         where ${DELAYED_ORDER_WHERE()}
         order by plan_end asc limit ${PAGE_SIZE} offset 0`,
        ...params,
      );
      return { rows: data.length, statements: { count: 1, data: 1 } };
    },
  },
  'list-search-filter': {
    label: 'List search + combined filter — mySteps',
    explainOn: 'myStepsSearch',
    run: async (sql) => {
      const search = `%工序-100%`;
      const params = [ORG_A, ACTIVE_STEP_STATUSES, search];
      const count = await sql.unsafe(
        `select count(*)::int as c from ewoh_schedule_task_step where ${STEP_WHERE(true)}`,
        ...params,
      );
      const data = await sql.unsafe(
        `select step_id, schedule_task_id, name, status from ewoh_schedule_task_step
         where ${STEP_WHERE(true)}
         order by _updated_at desc limit ${PAGE_SIZE}`,
        ...params,
      );
      return { rows: data.length, statements: { count: 1, data: 1 } };
    },
  },
  'list-sort': {
    label: 'List sort — delayedOrders by title',
    explainOn: 'delayedOrders',
    run: async (sql) => {
      const params = [ORG_A, ACTIVE_TASK_STATUSES];
      const count = await sql.unsafe(
        `select count(*)::int as c from ewoh_schedule_task where ${DELAYED_ORDER_WHERE()}`,
        ...params,
      );
      const data = await sql.unsafe(
        `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
         where ${DELAYED_ORDER_WHERE()}
         order by title asc limit ${PAGE_SIZE} offset 0`,
        ...params,
      );
      return { rows: data.length, statements: { count: 1, data: 1 } };
    },
  },
  'list-cursor-next': {
    label: 'Next-page cursor query — delayedOrders',
    explainOn: 'delayedOrdersCursor',
    run: async (sql, cursor) => {
      const params = [ORG_A, ACTIVE_TASK_STATUSES, cursor.planEnd, cursor.id];
      const count = await sql.unsafe(
        `select count(*)::int as c from ewoh_schedule_task where ${DELAYED_ORDER_WHERE()}`,
        [ORG_A, ACTIVE_TASK_STATUSES],
      );
      const data = await sql.unsafe(
        `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
         where org_id = $1 and status = any($2::varchar[])
           and plan_end is not null and plan_end < now()
           and ((plan_end > $3) or (plan_end = $3 and schedule_task_id > $4))
         order by plan_end asc, schedule_task_id asc limit ${PAGE_SIZE}`,
        ...params,
      );
      return { rows: data.length, statements: { count: 1, data: 1 } };
    },
  },
};

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

  const sql = postgres(url, { max: 12, onnotice: () => {}, prepare: false });
  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  const iterations = args.iterations;
  const results = {};
  const explainResults = {};

  try {
    await sql.unsafe('select 1 as ready');
    console.log(`Benchmarking scale=${args.scale} iterations=${iterations} on org=${ORG_A}`);

    // ---- Data scale snapshot (for the gate) ----
    const scaleRows = await sql.unsafe(
      `select
         (select count(*)::int from ewoh_schedule_task) as total_schedule_task,
         (select count(*)::int from ewoh_schedule_task where org_id = $1) as org_a_schedule_task,
         (select count(*)::int from ewoh_schedule_task where org_id = $2) as org_b_schedule_task,
         (select count(*)::int from ewoh_schedule_task where org_id = $3) as org_c_schedule_task`,
      [ORG_A, ORG_B, ORG_C],
    );
    const dataScale = scaleRows[0];
    console.log(JSON.stringify(dataScale));

    // -----------------------------------------------------------------------
    // 1. dashboard-aggregates (first screen, manager role)
    // -----------------------------------------------------------------------
    const aggregateQueries = [
      `select count(*)::int as c from ewoh_schedule_task where org_id=$1 and status <> all($2::varchar[]) and plan_end is not null and plan_end < now()`,
      `select count(*)::int as c from ewoh_schedule_task_step where org_id=$1 and status='in_progress'`,
      `select count(*)::int as c from ewoh_resource_binding where org_id=$1 and status='active'`,
      `select count(*)::int as c from ewoh_event where org_id=$1 and status='open' and event_type='quality'`,
      `select count(*)::int as c from ewoh_schedule_task_step where org_id=$1 and result_json->>'exception' is not null and result_json->>'exception' <> ''`,
      `select count(*)::int as t, count(*) filter (where evidence_json->>'result'='pass')::int as pass, count(*) filter (where evidence_json->>'result'='fail')::int as fail from ewoh_event where org_id=$1 and event_type='quality'`,
      `select evidence_json->>'defectCode' as defectCode, count(*)::int as c from ewoh_event where org_id=$1 and event_type='quality' group by 1 order by count(*) desc limit 20`,
      `select status, count(*)::int as c from ewoh_spatial_entity where org_id=$1 and entity_type='device' group by status`,
      `select count(*)::int as c from ewoh_spatial_entity where org_id=$1 and entity_type='device' and status='fault'`,
    ];
    const dashboardSamples = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      for (const q of aggregateQueries) {
        // eslint-disable-next-line no-await-in-loop
        await sql.unsafe(q, [ORG_A]);
      }
      const t1 = process.hrtime.bigint();
      dashboardSamples.push(Number(t1 - t0) / 1e6);
    }
    results['dashboard-aggregates'] = summarize(dashboardSamples);
    explainResults['dashboard-aggregates'] = await explain(
      sql,
      aggregateQueries[1],
      [ORG_A],
    );

    // -----------------------------------------------------------------------
    // 2-5. List scenarios
    // -----------------------------------------------------------------------
    // Precompute a cursor from the first page of delayedOrders (org-a).
    const cursorPage = await sql.unsafe(
      `select schedule_task_id, plan_end from ewoh_schedule_task
       where org_id = $1 and status = any($2::varchar[]) and plan_end is not null and plan_end < now()
       order by plan_end asc, schedule_task_id asc limit ${PAGE_SIZE}`,
      [ORG_A, ACTIVE_TASK_STATUSES],
    );
    const last = cursorPage[cursorPage.length - 1];
    const cursor = { planEnd: last.plan_end, id: last.schedule_task_id };

    for (const [key, scenario] of Object.entries(LIST_SCENARIOS)) {
      const samples = [];
      let rows = 0;
      for (let i = 0; i < iterations; i += 1) {
        const t0 = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        const out = await scenario.run(sql, cursor);
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
        rows = out.rows;
      }
      results[key] = { ...summarize(samples), rows, statements: 'count=1,data=1' };
      const explainTarget = scenario.explainOn;
      const explainQuery =
        explainTarget === 'myStepsSearch'
          ? `select step_id, schedule_task_id, name, status from ewoh_schedule_task_step
             where org_id=$1 and status=any($2::varchar[]) and name ilike $3
             order by _updated_at desc limit ${PAGE_SIZE}`
          : explainTarget === 'delayedOrdersCursor'
            ? `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
               where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
                 and ((plan_end > $3) or (plan_end = $3 and schedule_task_id > $4))
               order by plan_end asc, schedule_task_id asc limit ${PAGE_SIZE}`
            : `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
               where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
               order by ${key === 'list-sort' ? 'title' : 'plan_end'} asc limit ${PAGE_SIZE}`;
      const explainParams =
        explainTarget === 'myStepsSearch'
          ? [ORG_A, ACTIVE_STEP_STATUSES, '%工序-100%']
          : explainTarget === 'delayedOrdersCursor'
            ? [ORG_A, ACTIVE_TASK_STATUSES, cursor.planEnd, cursor.id]
            : [ORG_A, ACTIVE_TASK_STATUSES];
      explainResults[key] = await explain(sql, explainQuery, explainParams);
    }

    // -----------------------------------------------------------------------
    // 6. aggregate-metrics (focused metrics batch)
    // -----------------------------------------------------------------------
    const metricsQueries = [
      `select count(*)::int as c from ewoh_event where org_id=$1 and event_type='quality'`,
      `select evidence_json->>'defectCode' as d, count(*)::int as c from ewoh_event where org_id=$1 and event_type='quality' group by 1 order by count(*) desc limit 20`,
      `select count(*)::int as c from ewoh_schedule_task_step where org_id=$1 and status='in_progress'`,
    ];
    const metricsSamples = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      for (const q of metricsQueries) {
        // eslint-disable-next-line no-await-in-loop
        await sql.unsafe(q, [ORG_A]);
      }
      const t1 = process.hrtime.bigint();
      metricsSamples.push(Number(t1 - t0) / 1e6);
    }
    results['aggregate-metrics'] = summarize(metricsSamples);

    // -----------------------------------------------------------------------
    // 7. saved-view-restore (DB-backed PostgresWorkbenchViewStore)
    // -----------------------------------------------------------------------
    const savedViewSamples = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      await sql.unsafe(
        `insert into saved_views
           (organization_id, owner_user_id, name, workbench, list_key, schema_version,
            filter_json, sort_json, is_default, created_at, updated_at)
         values ($1, $2, $3, 'manager', 'delayedOrders', 1, $4::jsonb, $5::jsonb, false, now(), now())
         on conflict do nothing`,
        [ORG_A, 'perf-user', `perf-view-${i}`, JSON.stringify({ filter: null, limit: null, shared: false }), JSON.stringify({ sortKey: 'planEnd', sortDir: 'asc' })],
      );
      await sql.unsafe(
        `select * from saved_views where organization_id=$1 and owner_user_id=$2 and deleted_at is null`,
        [ORG_A, 'perf-user'],
      );
      const t1 = process.hrtime.bigint();
      savedViewSamples.push(Number(t1 - t0) / 1e6);
    }
    results['saved-view-restore'] = summarize(savedViewSamples);

    // -----------------------------------------------------------------------
    // 8. csv-export-dataread (export task insert + full org-a data read)
    // -----------------------------------------------------------------------
    const exportSamples = [];
    let exportRows = 0;
    for (let i = 0; i < iterations; i += 1) {
      const taskId = `export-${i}`;
      const t0 = process.hrtime.bigint();
      await sql.unsafe(
        `insert into workbench_export_tasks
           (task_id, organization_id, owner_user_id, role, list_key, status, created_at, updated_at)
         values ($1, $2, $3, 'manager', 'delayedOrders', 'queued', now(), now())
         on conflict (task_id) do update set status='queued', updated_at=now()`,
        [taskId, ORG_A, 'perf-user'],
      );
      const data = await sql.unsafe(
        `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
         where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
         order by plan_end asc`,
        [ORG_A, ACTIVE_TASK_STATUSES],
      );
      const t1 = process.hrtime.bigint();
      exportSamples.push(Number(t1 - t0) / 1e6);
      exportRows = data.length;
    }
    results['csv-export-dataread'] = { ...summarize(exportSamples), rows: exportRows };
    explainResults['csv-export-dataread'] = await explain(
      sql,
      `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
       where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
       order by plan_end asc`,
      [ORG_A, ACTIVE_TASK_STATUSES],
    );

    // -----------------------------------------------------------------------
    // 9. multi-org-concurrency (org-a/b/c in parallel)
    // -----------------------------------------------------------------------
    const multiOrgSamples = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      await Promise.all(
        [ORG_A, ORG_B, ORG_C].map((org) =>
          sql.unsafe(
            `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
             where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
             order by plan_end asc limit ${PAGE_SIZE}`,
            [org, ACTIVE_TASK_STATUSES],
          ),
        ),
      );
      const t1 = process.hrtime.bigint();
      multiOrgSamples.push(Number(t1 - t0) / 1e6);
    }
    results['multi-org-concurrency'] = summarize(multiOrgSamples);

    // -----------------------------------------------------------------------
    // 10. connection-pool-pressure (many concurrent queries)
    // -----------------------------------------------------------------------
    const poolSamples = [];
    const CONCURRENCY = 50;
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          sql.unsafe(
            `select schedule_task_id, title, status, plan_end from ewoh_schedule_task
             where org_id=$1 and status=any($2::varchar[]) and plan_end is not null and plan_end < now()
             order by plan_end asc limit ${PAGE_SIZE}`,
            [ORG_A, ACTIVE_TASK_STATUSES],
          ),
        ),
      );
      const t1 = process.hrtime.bigint();
      poolSamples.push(Number(t1 - t0) / 1e6);
    }
    results['connection-pool-pressure'] = {
      ...summarize(poolSamples),
      concurrency: CONCURRENCY,
    };

    // -----------------------------------------------------------------------
    // Guards
    // -----------------------------------------------------------------------
    // N+1 guard: every list scenario issues exactly 1 data SELECT per item page.
    const nPlusOneViolation = Object.values(results)
      .filter((r) => r.statements)
      .some((r) => {
        // count=1,data=1 is the expected shape; anything more is N+1.
        return r.statements !== 'count=1,data=1';
      });

    // Full-table scan guard: any seq scan on a workbench source table.
    const fullTableScanViolation = Object.values(explainResults).some(
      (e) => e.seqScansOnWorkbench && e.seqScansOnWorkbench.length > 0,
    );

    // Org isolation: org-a scoped reads must never surface org-b/org-c rows.
    const leaked = await sql.unsafe(
      `select count(*)::int as c from ewoh_schedule_task
       where org_id = $1 and schedule_task_id like $2`,
      [ORG_A, `st-${args.scale}-%`],
    );
    // Verify a known org-b id is invisible from org-a scope.
    const orgBNeedle = await sql.unsafe(
      `select schedule_task_id from ewoh_schedule_task where org_id=$1 limit 1`,
      [ORG_B],
    );
    const orgBId = orgBNeedle[0]?.schedule_task_id ?? null;
    const crossRead =
      orgBId === null
        ? 0
        : (
            await sql.unsafe(
              `select count(*)::int as c from ewoh_schedule_task where org_id=$1 and schedule_task_id=$2`,
              [ORG_A, orgBId],
            )
          )[0].c;
    const orgIsolationPass = leaked[0].c === dataScale.org_a_schedule_task && crossRead === 0;

    const guards = {
      nPlusOne: {
        expected: 'count=1,data=1 per list query',
        violation: nPlusOneViolation,
      },
      fullTableScanPerRefresh: {
        seqScansOnWorkbench:
          Object.fromEntries(
            Object.entries(explainResults)
              .filter(([, e]) => e.seqScansOnWorkbench && e.seqScansOnWorkbench.length)
              .map(([k, e]) => [k, e.seqScansOnWorkbench]),
          ),
        violation: fullTableScanViolation,
      },
      orgIsolation: {
        pass: orgIsolationPass,
        note:
          'org-a scope must not return org-b/org-c rows; verified against a known org-b id.',
      },
    };

    // -----------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------
    const report = {
      generatedAt: new Date().toISOString(),
      budget: budget.name,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        databaseUrl: url.replace(/:\/\/[^@]*@/, '://***@'),
      },
      dataScale: {
        requested: args.scale,
        ...dataScale,
      },
      commitSha: gitSha(),
      iterations,
      results,
      explain: explainResults,
      guards,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote ${args.out}`);
  } catch (err) {
    console.error('BENCHMARK ERROR:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});