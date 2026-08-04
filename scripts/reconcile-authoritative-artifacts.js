#!/usr/bin/env node
// AUTHORITATIVE_ARTIFACT_RECONCILE_V1
// 跨制品对账 CLI（权威制品一致性 + Work Graph Phase 1）。
// 只读比对仓库内各「权威事实源」制品，报告检查项 PASS/FAIL、冲突与建议；
// 绝不静默改写任何权威源文件。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const indexer = require(path.join(root, 'tools', 'work-indexer', 'index.js'));
const routeAudit = require(path.join(__dirname, 'audit-openapi-routes.js'));

// Evidence 结构完整性要求的 9 个字段（允许别名）。
const EVIDENCE_REQUIRED_FIELDS = [
  ['workItemId', 'workItemIds'],
  ['commitSha'],
  ['envFingerprint', 'environment'],
  ['dependencyFingerprint', 'dependencyVersion'],
  ['result'],
  ['producedAt', 'testTime'],
  ['expiresAt'],
  ['verifier'],
  ['checksum'],
];

// 任务打开/进行中状态（缺少对应 Evidence 时需标记 Blocked by External Validation）。
const TASK_OPEN_STATUSES = new Set([
  'open',
  'proposed',
  'refining',
  'ready',
  'claimed',
  'in progress',
  'blocked',
  'review',
  'validation',
  'integrated',
]);

const BLOCKED_MARKER = /blocked by external validation/i;

function readFile(rootDir, relative) {
  const target = path.join(rootDir, relative);
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, 'utf8');
}

function readJson(rootDir, relative) {
  const text = readFile(rootDir, relative);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readYaml(rootDir, relative) {
  const text = readFile(rootDir, relative);
  if (text == null) return null;
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
}

function runGit(args, rootDir) {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .replace(/\s+$/g, '');
  } catch {
    return '';
  }
}

function headSha(rootDir) {
  return runGit(['rev-parse', 'HEAD'], rootDir) || '';
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function diffArrays(left, right) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  return {
    onlyInLeft: (left || []).filter((value) => !rightSet.has(value)).sort(),
    onlyInRight: (right || []).filter((value) => !leftSet.has(value)).sort(),
  };
}

function freshRouteAudit(rootDir) {
  const specOperations = routeAudit.extractSpecOperations(path.join(rootDir, 'openapi/ewoh.yaml'));
  const orchestrationSpec = path.join(rootDir, 'openapi/work-orchestration.yaml');
  if (fs.existsSync(orchestrationSpec)) {
    specOperations.push(...routeAudit.extractSpecOperations(orchestrationSpec));
  }
  const controllerOperations = routeAudit.extractControllerOperations(
    path.join(rootDir, 'ewoh-spark-app/server'),
  );
  return {
    controllerKeys: controllerOperations.map(routeAudit.operationKey).sort(),
    specKeys: specOperations.map(routeAudit.operationKey).sort(),
    result: routeAudit.auditRoutes(controllerOperations, specOperations),
  };
}

function countByStatus(rows) {
  const counts = {};
  for (const row of rows || []) {
    const status = String(row.status || 'unknown').trim() || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function reconcile(rootDir) {
  const checks = [];
  const conflicts = [];
  const recommendations = [];

  const artifactsDir = path.join(rootDir, '.codex', 'artifacts');
  const readme = readFile(rootDir, 'README.md');
  const changelog = readFile(rootDir, 'CHANGELOG.md');
  const stateJson = readJson(rootDir, '.codex/artifacts/state.json');
  const phaseState = readFile(rootDir, '.codex/artifacts/phase-state.md');
  const taskBoardText = readFile(rootDir, '.codex/artifacts/task-board.md') || '';
  const gatesText = readFile(rootDir, '.codex/artifacts/gates.md') || '';
  const releaseManifest = readYaml(rootDir, 'docs/delivery/release-manifest.yaml');
  const schemaManifest = readYaml(rootDir, 'db/contracts/schema-manifest.yaml');
  const routeManifest = readJson(rootDir, 'openapi/route-manifest.json');

  let evidence = [];
  try {
    evidence = indexer.parseEvidence(artifactsDir, rootDir);
  } catch (error) {
    evidence = [];
    conflicts.push({
      name: 'evidence_parse',
      detail: `could not parse evidence via work-indexer: ${error.message}`,
    });
  }

  // ---------------------------------------------------------------------------
  // a) 版本一致性：CHANGELOG 最新版本号 == release-manifest.release
  // ---------------------------------------------------------------------------
  const versionMatch = changelog?.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}/m);
  const latestVersion = versionMatch?.[1];
  const manifestVersion = releaseManifest?.release;
  const versionConsistent = Boolean(
    latestVersion && manifestVersion && latestVersion === manifestVersion,
  );
  checks.push({
    name: 'version_changelog_vs_release_manifest',
    ok: versionConsistent,
    detail: `changelog=${latestVersion ?? 'missing'}, release-manifest=${manifestVersion ?? 'missing'}`,
  });
  if (!versionConsistent) {
    conflicts.push({
      name: 'version_changelog_vs_release_manifest',
      detail: `CHANGELOG latest (${latestVersion ?? 'missing'}) != release-manifest.release (${manifestVersion ?? 'missing'})`,
    });
    recommendations.push(
      'Align docs/delivery/release-manifest.yaml.release and the CHANGELOG.md top banner to the same version.',
    );
  }

  // ---------------------------------------------------------------------------
  // b) state.json.trace_id 出现在 phase-state.md
  // ---------------------------------------------------------------------------
  const traceId = stateJson?.trace_id;
  const tracePresent = Boolean(traceId && phaseState?.includes(traceId));
  checks.push({
    name: 'trace_id_in_phase_state',
    ok: tracePresent,
    detail: `trace_id=${traceId ?? 'missing'}, phase-state mentions=${tracePresent}`,
  });
  if (!tracePresent) {
    conflicts.push({
      name: 'trace_id_in_phase_state',
      detail: `state.json.trace_id (${traceId ?? 'missing'}) is not referenced in phase-state.md`,
    });
    recommendations.push(
      'Reference state.json.trace_id in .codex/artifacts/phase-state.md (Trace line) or align the identifiers.',
    );
  }

  // ---------------------------------------------------------------------------
  // c) 数据库表口径：schema-manifest 计算 vs 其它权威源声称
  // ---------------------------------------------------------------------------
  const managedTables = schemaManifest?.managed_tables || [];
  const additional = schemaManifest?.additional_hardened_existing_tables || [];
  const managedCount = managedTables.length;
  const additionalCount = additional.length;
  const schemaStatusCounts = countByStatus(managedTables);
  const schemaNew = schemaStatusCounts.new || 0;
  const schemaAltered = schemaStatusCounts.altered || 0;
  const schemaMappedExisting = schemaStatusCounts['mapped-existing'] || 0;
  const totalComputed = managedCount + additionalCount;

  const changelogClaimed = changelog?.match(/(\d+)\s*→\s*(\d+)/);
  const changelogTo = changelogClaimed?.[2];
  const claimed =
    changelogTo && Number(changelogTo) === totalComputed
      ? totalComputed
      : changelogTo
        ? Number(changelogTo)
        : 0;
  const stateClaimed = stateJson?.verification_state?.['postgres_ddl_rls_gate']
    ? String(stateJson.verification_state['postgres_ddl_rls_gate']).match(/(\d+)\s*managed tables/)?.[1]
    : null;
  const releaseClaimed = releaseManifest?.evidence?.postgres_gate
    ? String(releaseManifest.evidence.postgres_gate).match(/(\d+)\s*managed tables/)?.[1]
    : null;

  const dbConsistent =
    totalComputed === claimed &&
    (!stateClaimed || Number(stateClaimed) === totalComputed) &&
    (!releaseClaimed || Number(releaseClaimed) === totalComputed);

  checks.push({
    name: 'db_table_footprint_reconcile',
    ok: dbConsistent,
    detail:
      `computed=${totalComputed} (managed ${managedCount}=new ${schemaNew}+altered ${schemaAltered}+` +
      `mapped-existing ${schemaMappedExisting}; additional_hardened ${additionalCount}); ` +
      `claimed: changelog=${changelogTo ?? 'n/a'} (48->51), state.json=${stateClaimed ?? 'n/a'}, ` +
      `release-manifest=${releaseClaimed ?? 'n/a'}`,
  });
  if (!dbConsistent) {
    conflicts.push({
      name: 'db_table_footprint_reconcile',
      detail:
        `C1 table-count reconcile mismatch: schema-manifest computes ${totalComputed} managed tables ` +
        `(managed ${managedCount} + additional_hardened ${additionalCount}), but CHANGELOG/state.json/` +
        `release-manifest claim 51. computed=${totalComputed} claimed(changelog=${changelogTo ?? 'n/a'}, ` +
        `state=${stateClaimed ?? 'n/a'}, release=${releaseClaimed ?? 'n/a'}).`,
    });
    recommendations.push(
      'C1: 51-table footprint has no single authoritative source. Reconcile db/contracts/schema-manifest.yaml ' +
        'with CHANGELOG (48->51), state.json postgres_ddl_rls_gate, and release-manifest evidence.postgres_gate. ' +
        'Do not auto-edit any authoritative source; decide the canonical count and update all sources consistently.',
    );
  }

  // ---------------------------------------------------------------------------
  // d) OpenAPI route-manifest 与实时扫描一致
  // ---------------------------------------------------------------------------
  let fresh = null;
  let routeOk = false;
  try {
    fresh = freshRouteAudit(rootDir);
    routeOk =
      Boolean(routeManifest) &&
      arraysEqual(routeManifest.controllerKeys, fresh.controllerKeys) &&
      arraysEqual(routeManifest.specKeys, fresh.specKeys) &&
      routeManifest.controllerOperations === fresh.result.controllerOperations &&
      routeManifest.specOperations === fresh.result.specOperations &&
      routeManifest.documentedControllerOperations === fresh.result.documentedControllerOperations &&
      (routeManifest.undocumented || []).length === fresh.result.undocumented.length &&
      (routeManifest.unimplemented || []).length === fresh.result.unimplemented.length;
  } catch (error) {
    routeOk = false;
  }
  checks.push({
    name: 'route_manifest_consistent_with_live_scan',
    ok: routeOk,
    detail: fresh
      ? `manifest=${routeManifest?.controllerOperations ?? 'missing'}/${routeManifest?.specOperations ?? 'missing'}, ` +
        `live=${fresh.result.controllerOperations}/${fresh.result.specOperations}`
      : 'route manifest could not be reconciled',
  });
  if (!routeOk) {
    const diff = fresh
      ? diffArrays(routeManifest.controllerKeys || [], fresh.controllerKeys)
      : { onlyInLeft: [], onlyInRight: [] };
    conflicts.push({
      name: 'route_manifest_consistent_with_live_scan',
      detail: `route-manifest.json differs from live scan; controller +${diff.onlyInLeft.length}/-${diff.onlyInRight.length}`,
    });
    recommendations.push(
      'Regenerate openapi/route-manifest.json with: node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json',
    );
  }

  // ---------------------------------------------------------------------------
  // e) Evidence 结构完整性：9 字段必填
  // ---------------------------------------------------------------------------
  const evidenceMissing = [];
  for (const entry of evidence) {
    const missing = [];
    for (const [primary, alias] of EVIDENCE_REQUIRED_FIELDS) {
      const value = entry[primary];
      const aliasValue = alias ? entry[alias] : undefined;
      const present =
        value !== undefined && value !== null && value !== '' ||
        (aliasValue !== undefined && aliasValue !== null && aliasValue !== '');
      if (!present) missing.push(primary);
    }
    if (missing.length > 0) {
      evidenceMissing.push({ evidenceId: entry.evidenceId, missing });
    }
  }
  const evidenceComplete = evidenceMissing.length === 0;
  checks.push({
    name: 'evidence_structure_complete',
    ok: evidenceComplete,
    detail: `${evidence.length} evidence entries, ${evidenceMissing.length} incomplete`,
  });
  for (const item of evidenceMissing) {
    conflicts.push({
      name: 'evidence_structure_complete',
      detail: `${item.evidenceId} missing fields: ${item.missing.join(', ')}`,
    });
  }
  if (evidenceMissing.length > 0) {
    recommendations.push(
      'Add the missing required fields to each evidence file front-matter (workItemId, commitSha, envFingerprint/environment, dependencyFingerprint/dependencyVersion, result, producedAt/testTime, expiresAt, verifier, checksum).',
    );
  }

  // ---------------------------------------------------------------------------
  // f) 任务板/门禁：打开/进行中的任务有对应 Evidence 或标记 Blocked
  // ---------------------------------------------------------------------------
  const tasks = indexer.parseTaskBoard(taskBoardText);
  const openTasks = tasks.filter((task) => TASK_OPEN_STATUSES.has(String(task.status).toLowerCase()));
  const evidenceIds = new Set();
  for (const entry of evidence) {
    for (const id of entry.workItemIds || [entry.workItemId]) {
      if (id) evidenceIds.add(String(id));
    }
  }
  const uncoveredOpen = [];
  for (const task of openTasks) {
    const taskEvidence = evidenceIds.has(task.id);
    const text = `${task.title || ''} ${task.evidence || ''} ${task.summary || ''}`;
    const blocked = BLOCKED_MARKER.test(text);
    if (!taskEvidence && !blocked) {
      uncoveredOpen.push({ id: task.id, status: task.status, evidence: task.evidence || '' });
    }
  }
  const openTasksCovered = uncoveredOpen.length === 0;
  checks.push({
    name: 'open_tasks_have_evidence_or_blocked',
    ok: openTasksCovered,
    detail: `${openTasks.length} open/in-progress tasks, ${uncoveredOpen.length} without evidence or blocked marker`,
  });
  for (const item of uncoveredOpen) {
    conflicts.push({
      name: 'open_tasks_have_evidence_or_blocked',
      detail: `task ${item.id} (${item.status}) is open/in-progress without evidence ${item.evidence ? `(${item.evidence})` : ''} and not marked 'Blocked by External Validation'`,
    });
  }
  if (uncoveredOpen.length > 0) {
    recommendations.push(
      'For each open/in-progress task lacking evidence, either add a round-* evidence file, or mark it explicitly as "Blocked by External Validation".',
    );
  }

  return {
    root: rootDir,
    headSha: headSha(rootDir),
    time: new Date().toISOString(),
    checks,
    conflicts,
    recommendations,
    summary: {
      passed: checks.filter((entry) => entry.ok).length,
      failed: checks.filter((entry) => !entry.ok).length,
      total: checks.length,
      conflictCount: conflicts.length,
      evidenceCount: evidence.length,
      openTaskCount: openTasks.length,
    },
  };
}

function parseArgs(argv) {
  const options = {
    root,
    strict: false,
    json: false,
    diff: false,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = path.resolve(argv[++index]);
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--diff') {
      options.diff = true;
    } else if (argument === '--output') {
      options.output = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printText(result) {
  const summary = result.summary;
  console.log(`AUTHORITATIVE ARTIFACT RECONCILE: ${summary.passed}/${summary.total} checks passed`);
  console.log(`  root: ${result.root}`);
  console.log(`  head: ${result.headSha || 'unknown'}`);
  console.log(`  time: ${result.time}`);
  console.log(`  conflicts: ${summary.conflictCount}`);
  for (const entry of result.checks) {
    const tag = entry.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${entry.name}: ${entry.detail}`);
  }
  if (result.conflicts.length > 0) {
    console.log('\nConflicts (authoritative sources are NOT modified):');
    for (const conflict of result.conflicts) {
      console.log(`  - ${conflict.name}: ${conflict.detail}`);
    }
  }
  if (result.recommendations.length > 0) {
    console.log('\nRecommendations / suggested fixes (report only, no auto-fix):');
    for (const recommendation of result.recommendations) {
      console.log(`  - ${recommendation}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = reconcile(options.root);
  const json = JSON.stringify(result, null, 2);
  if (options.json) {
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${json}\n`, 'utf8');
      console.log(`Reconcile report written: ${options.output}`);
    } else {
      console.log(json);
    }
  } else {
    printText(result);
  }
  if (options.diff && result.conflicts.length > 0) {
    console.log('\nDiff / fix suggestions (report only, no silent rewrite):');
    for (const recommendation of result.recommendations) {
      console.log(`  - ${recommendation}`);
    }
  }
  // 冲突（FAIL）时返回非零退出码；--strict 同样强制退出 1。
  if (result.conflicts.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  reconcile,
  parseArgs,
  EVIDENCE_REQUIRED_FIELDS,
  TASK_OPEN_STATUSES,
};