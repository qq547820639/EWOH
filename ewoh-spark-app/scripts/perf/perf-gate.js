#!/usr/bin/env node
/**
 * Task 7 — Performance budget gate for the Role Workbench.
 *
 * Reads the benchmark report produced by scripts/perf/workbench-benchmark.js
 * and the budget in scripts/perf/perf-budget.json, evaluates every scenario and
 * the hard guards (data scale, N+1, full-table scan, org isolation), and exits
 * NON-ZERO (FAIL, not warn) if anything is exceeded or missing.
 *
 * It never fabricates a PASS: if the report is absent, or the report is marked
 * BLOCKED_BY_ENVIRONMENT, the gate FAILS.
 *
 * Writes a machine-readable verdict to <repo>/output/perf-budget-gate.json
 * carrying budget, environment, data scale and the current commit SHA.
 *
 * Usage:
 *   node scripts/perf/perf-gate.js                       # default report
 *   node scripts/perf/perf-gate.js --report <path>       # custom report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..');
const BUDGET_FILE = path.join(__dirname, 'perf-budget.json');
const DEFAULT_REPORT = path.join(repoRoot, 'output', 'perf-workbench-report.json');
const GATE_OUT = path.join(repoRoot, 'output', 'perf-budget-gate.json');

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { report: DEFAULT_REPORT, out: GATE_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') args.report = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function evaluateScenario(name, budget, measured) {
  if (!measured || typeof measured.p95Ms !== 'number') {
    return { scenario: name, status: 'fail', reason: 'missing measurement' };
  }
  const failures = [];
  if (measured.p95Ms > budget.p95Ms) {
    failures.push(`p95 ${measured.p95Ms}ms > ${budget.p95Ms}ms`);
  }
  if (measured.meanMs > budget.meanMs) {
    failures.push(`mean ${measured.meanMs}ms > ${budget.meanMs}ms`);
  }
  if (measured.p99Ms > budget.durationMs) {
    failures.push(`p99 ${measured.p99Ms}ms > ${budget.durationMs}ms (duration spike)`);
  }
  return {
    scenario: name,
    status: failures.length ? 'fail' : 'pass',
    measured: { p50Ms: measured.p50Ms, p95Ms: measured.p95Ms, p99Ms: measured.p99Ms, meanMs: measured.meanMs },
    budget: { p95Ms: budget.p95Ms, meanMs: budget.meanMs, durationMs: budget.durationMs },
    failures,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.report)) {
    console.error(
      `FAIL: benchmark report not found at ${args.report}. Run scripts/perf/workbench-benchmark.js first.`,
    );
    process.exit(2);
  }

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));

  // ---- BLOCKED_BY_ENVIRONMENT: never fabricate a PASS. ----
  const blockedByEnvironment = report.blockedByEnvironment === true;
  if (blockedByEnvironment) {
    console.error('FAIL: report is BLOCKED_BY_ENVIRONMENT — no measurements were taken.');
    writeGate(args.out, {
      blockedByEnvironment: true,
      overall: 'fail',
      summary: { pass: 0, fail: 1, total: 1 },
    });
    process.exit(1);
  }

  // ---- Data scale hard gate. ----
  const scale = report.dataScale || {};
  const totalRows = Number(scale.total_schedule_task ?? 0);
  const dataScalePass = totalRows >= Number(budget.dataScale.minTotalRows || 0);
  if (!dataScalePass) {
    console.error(
      `FAIL: data scale requirement not met. Required >= ${budget.dataScale.minTotalRows} schedule_task rows, measured ${totalRows}.`,
    );
  }

  // ---- Scenario budgets. ----
  const decisions = {};
  let failCount = 0;
  for (const [name, scenarioBudget] of Object.entries(budget.scenarios)) {
    const measured = report.results && report.results[name];
    const decision = evaluateScenario(name, scenarioBudget, measured);
    decisions[name] = decision;
    if (decision.status === 'fail') failCount += 1;
  }

  // ---- Guards. ----
  const guardsPass = !report.guards?.nPlusOne?.violation &&
    !report.guards?.fullTableScanPerRefresh?.violation &&
    report.guards?.orgIsolation?.pass === true;
  if (!guardsPass) failCount += 1;

  const overall = dataScalePass && failCount === 0 ? 'pass' : 'fail';

  // ---- Verdict artifact: budget + environment + data scale + commit SHA. ----
  const verdict = {
    generatedAt: new Date().toISOString(),
    budget: budget.name,
    budgetPath: budget,
    environment: report.environment ?? null,
    dataScale: { requested: report.dataScale?.requested, ...scale },
    commitSha: report.commitSha || gitSha(),
    blockedByEnvironment: false,
    decisions,
    guards: report.guards ?? null,
    guardsPass,
    dataScalePass,
    summary: { pass: failCount === 0 ? Object.keys(decisions).length : 0, fail: failCount, total: Object.keys(budget.scenarios).length },
    overall,
  };

  writeGate(args.out, verdict);

  // ---- Human-readable table. ----
  console.log('性能预算门禁（Role Workbench 大数据）');
  console.log('='.repeat(96));
  console.log('场景'.padEnd(26) + '状态'.padEnd(8) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'mean'.padStart(8) + '  预算(p95/mean/dur)');
  console.log('-'.repeat(96));
  for (const [name, d] of Object.entries(decisions)) {
    const m = d.measured || {};
    const b = d.budget || {};
    console.log(
      name.padEnd(26) +
        (d.status.toUpperCase()).padEnd(8) +
        String(m.p50Ms ?? '—').padStart(8) +
        String(m.p95Ms ?? '—').padStart(8) +
        String(m.p99Ms ?? '—').padStart(8) +
        String(m.meanMs ?? '—').padStart(8) +
        `   ${b.p95Ms ?? '—'}/${b.meanMs ?? '—'}/${b.durationMs ?? '—'}` +
        (d.failures?.length ? '  << ' + d.failures.join('; ') : ''),
    );
  }
  console.log('-'.repeat(96));
  console.log(`数据规模: ${totalRows} schedule_task 行 (要求 >= ${budget.dataScale.minTotalRows}) ${dataScalePass ? 'PASS' : 'FAIL'}`);
  console.log(`守卫: N+1=${report.guards?.nPlusOne?.violation ? 'FAIL' : 'PASS'} 全表扫描=${report.guards?.fullTableScanPerRefresh?.violation ? 'FAIL' : 'PASS'} 组织隔离=${report.guards?.orgIsolation?.pass ? 'PASS' : 'FAIL'}`);
  console.log(`\n总体: ${overall.toUpperCase()} (fail=${failCount})`);
  console.log(`Wrote ${args.out}`);

  process.exit(overall === 'pass' ? 0 : 1);
}

function writeGate(out, verdict) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(verdict, null, 2));
}

main();