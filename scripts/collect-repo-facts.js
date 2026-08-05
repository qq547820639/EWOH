#!/usr/bin/env node
'use strict';

/**
 * Collect authoritative repository facts into a single machine-readable snapshot
 * that conforms to contracts/repository-facts/repository-facts.schema.json.
 *
 * This is the "single source of truth" for version, test counts, evidence
 * completeness, work-graph, OpenAPI and DB footprint. Consumers (release gate,
 * CI, reconcile tooling) read this snapshot instead of re-deriving counts from
 * scattered artifacts, so drift is detected instead of silently repeated.
 *
 * Usage:
 *   node scripts/collect-repo-facts.js [--out <path>] [--generatedAt <ISO>]
 *
 * The snapshot is purely informational; it does not mutate any source file.
 * Consistency (non-zero exit on conflict) is enforced by scripts/audit-repo-facts.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const routeAudit = require('./audit-openapi-routes');
const truth = require('./truth-source');

function readFileSafe(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) {
    return null;
  }
  return fs.readFileSync(target, 'utf8');
}

function readJsonSafe(relative) {
  const text = readFileSafe(relative);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readYamlSafe(relative) {
  const text = readFileSafe(relative);
  if (!text) {
    return null;
  }
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
}

function gitHead() {
  return truth.gitHead();
}

function gitBranch() {
  return truth.gitBranch();
}

/**
 * Parse a Jest `--json` result file (numTotalTestSuites / numTotalTests /
 * numPassedTests) into a human-readable "N suites / M tests" label.
 * Returns null when the file is absent or lacks the expected counters.
 */
function parseJestJson(relative) {
  const data = readJsonSafe(relative);
  if (
    !data ||
    typeof data.numTotalTestSuites !== 'number' ||
    typeof data.numTotalTests !== 'number'
  ) {
    return null;
  }
  return `${data.numTotalTestSuites} suites / ${data.numTotalTests} tests`;
}

/**
 * Read live test counts from CI-generated JSON reports where present.
 *
 * When a report file does not exist the corresponding count is null (the CI
 * job that runs `jest --json --outputFile=...` fills it in); collectors and
 * auditors must treat null as "not yet measured" rather than guessing a value.
 */
function readReportTestCounts() {
  const counts = {
    serverJest: null,
    clientJest: null,
    e2e: null,
    browser: null,
  };

  counts.serverJest =
    parseJestJson('ewoh-spark-app/jest.results.json') ||
    parseJestJson('ewoh-spark-app/test-results.json') ||
    null;

  counts.clientJest =
    parseJestJson('ewoh-spark-app/client/jest.results.json') ||
    parseJestJson('ewoh-spark-app/client/test-results.json') ||
    null;

  // Playwright JSON reporter output: an array of suite trees with a trailing
  // stats object. We read the total test count from the trailing stats bucket.
  const playwrightJson =
    readJsonSafe('ewoh-spark-app/playwright-report/test-results.json') ||
    readJsonSafe('ewoh-spark-app/playwright-report/results.json') ||
    readJsonSafe('ewoh-spark-app/test-results.json') ||
    null;
  if (playwrightJson) {
    const stats = Array.isArray(playwrightJson)
      ? playwrightJson[playwrightJson.length - 1] &&
        playwrightJson[playwrightJson.length - 1].stats
      : playwrightJson.stats;
    if (stats && typeof stats.expected === 'number') {
      counts.browser = `${stats.expected}/${stats.expected}`;
    }
  }

  return counts;
}

function evidenceStats() {
  const stats = { total: 0, incomplete: 0, expired: 0, missingCommitSha: 0 };
  const dir = path.join(root, '.codex', 'artifacts', 'work', 'evidence');
  if (!fs.existsSync(dir)) {
    return stats;
  }
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      stats.incomplete += 1;
      continue;
    }
    stats.total += 1;
    if (!fm.commitSha) {
      stats.missingCommitSha += 1;
    }
    if (fm.expiresAt) {
      const exp = Date.parse(String(fm.expiresAt));
      if (!Number.isNaN(exp) && exp < now) {
        stats.expired += 1;
      }
    }
  }
  return stats;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    return null;
  }
  const out = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) {
      continue;
    }
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function workGraph() {
  // Compute the work-graph summary live from the authoritative artifacts using
  // the work-indexer, rather than reading a may-be-stale/missing aggregate in
  // state.json. This keeps the snapshot a single source of truth.
  try {
    const indexer = require('../tools/work-indexer/index.js');
    const graph = indexer.indexWorkGraph(
      path.join(root, '.codex', 'artifacts'),
      { root },
    );
    const s = graph.summary || {};
    return {
      items: s.itemCount || 0,
      edges: s.edgeCount || 0,
      actors: s.actorCount || 0,
      evidence: s.evidenceCount || 0,
      gates: s.gateCount || 0,
      conflicts: (s.conflicts || []).length,
    };
  } catch {
    const state = readJsonSafe('.codex/artifacts/state.json');
    const summary = state && state.work_graph_summary;
    return {
      items: summary && summary.items ? summary.items : 0,
      edges: summary && summary.edges ? summary.edges : 0,
      actors: summary && summary.actors ? summary.actors : 0,
      evidence: summary && summary.evidence ? summary.evidence : 0,
      gates: summary && summary.gates ? summary.gates : 0,
      conflicts: summary && summary.conflicts ? summary.conflicts : 0,
    };
  }
}

function openapiFacts() {
  const fresh = (() => {
    const specOperations = routeAudit.extractSpecOperations(path.join(root, 'openapi/ewoh.yaml'));
    const orchestrationSpec = path.join(root, 'openapi/work-orchestration.yaml');
    if (fs.existsSync(orchestrationSpec)) {
      specOperations.push(...routeAudit.extractSpecOperations(orchestrationSpec));
    }
    const controllerOperations = routeAudit.extractControllerOperations(path.join(root, 'ewoh-spark-app/server'));
    return routeAudit.auditRoutes(controllerOperations, specOperations);
  })();
  return {
    controller: fresh.controllerOperations,
    spec: fresh.specOperations,
    unimplemented: fresh.unimplemented.length,
  };
}

function databaseFacts() {
  const manifest = readYamlSafe('release/ewoh-0.6.0-rc4/docs/delivery/release-manifest.yaml');
  const db = manifest && manifest.contracts && manifest.contracts.database;
  return {
    managedTables: db && db.managed_tables ? db.managed_tables : 0,
    physicalTables: db && db.physical_tables ? db.physical_tables : 0,
  };
}

function collect(opts) {
  opts = opts || {};
  const args = process.argv.slice(2);
  const outArgIndex = args.indexOf('--out');
  const outPath = opts.outPath !== undefined ? opts.outPath
    : (outArgIndex >= 0 ? args[outArgIndex + 1] : null);
  const generatedAtArgIndex = args.indexOf('--generatedAt');
  const generatedAt = generatedAtArgIndex >= 0 ? args[generatedAtArgIndex + 1] : new Date().toISOString();

  const evidence = evidenceStats();
  const reportCounts = readReportTestCounts();
  const openapi = openapiFacts();
  const liveOpenapi = `${openapi.controller}/${openapi.controller}`;

  const testCounts = {
    serverJest: reportCounts.serverJest,
    clientJest: reportCounts.clientJest,
    // OpenAPI is always derived live from the route audit.
    openapi: liveOpenapi,
    e2e: reportCounts.e2e,
    browser: reportCounts.browser,
    evidence: evidence.total,
  };

  for (const key of ['serverJest', 'clientJest', 'e2e', 'browser']) {
    if (testCounts[key] === null) {
      console.warn(
        `testCounts.${key}: 报告缺失，未生成（CI 中由 jest --json --outputFile 输出文件填充）`,
      );
    }
  }

  const snapshot = {
    schema: 'ewoh:///repository-facts/v1',
    generatedAt,
    head: gitHead(),
    branch: gitBranch(),
    version: truth.readVersion() || 'unknown',
    testCounts,
    evidence,
    workGraph: workGraph(),
    openapi,
    database: databaseFacts(),
    checks: [],
  };

  if (outPath) {
    const target = path.resolve(root, outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`REPO FACTS SNAPSHOT written: ${target}`);
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
  return snapshot;
}

if (require.main === module) {
  try {
    collect();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  collect,
  parseJestJson,
  readFileSafe,
  readJsonSafe,
  readReportTestCounts,
  readYamlSafe,
};