#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const routeAudit = require('./audit-openapi-routes');

const REQUIRED_NAVIGATION = [
  'src/edge_platform',
  'ewoh-spark-app',
  'contracts',
  'openapi',
  'db',
  'catalog',
  'release',
  'deploy',
  'docs',
  'tests',
  'scripts',
  'tools',
  'security',
  'delivery',
];

const REQUIRED_FILES = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'Makefile',
  'pyproject.toml',
];

const REQUIRED_DATA_SOURCES = [
  'simulated',
  'real',
  'controlled_test',
  'replayed',
  'stale',
  'offline',
];

const REQUIRED_ERROR_FIELDS = [
  'code',
  'errorCode',
  'message',
  'fieldErrors',
  'requestId',
  'retryable',
  'recommendedAction',
  'details',
];

function readFile(rootDir, relative) {
  const target = path.join(rootDir, relative);
  if (!fs.existsSync(target)) {
    return null;
  }
  return fs.readFileSync(target, 'utf8');
}

function slug(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function parseTaskBoardRows(text) {
  if (!text) {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => /^\|\s*T-\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return {
        id: cells[1] || '',
        task: cells[2] || '',
        owner: cells[3] || '',
        status: cells[4] || '',
        evidence: cells[5] || '',
      };
    });
}

function freshRouteAudit(rootDir) {
  const specOperations = routeAudit.extractSpecOperations(
    path.join(rootDir, 'openapi/ewoh.yaml'),
  );
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

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function auditRepoFacts(rootDir) {
  const checks = [];

  const readme = readFile(rootDir, 'README.md');
  check(checks, 'readme_exists', Boolean(readme), 'README.md must exist');

  for (const item of REQUIRED_NAVIGATION) {
    const exists = fs.existsSync(path.join(rootDir, item));
    const mentioned =
      Boolean(readme) &&
      (readme.includes(`\`${item}/\``) || readme.includes(`\`${item}\``));
    check(
      checks,
      `readme_navigates_${slug(item)}`,
      exists && mentioned,
      `${item}: exists=${exists}, mentioned_in_readme=${mentioned}`,
    );
  }

  for (const item of REQUIRED_FILES) {
    check(
      checks,
      `required_file_${slug(item)}`,
      fs.existsSync(path.join(rootDir, item)),
      `${item} must exist at repository root`,
    );
  }

  const changelog = readFile(rootDir, 'CHANGELOG.md');
  const versionMatch = changelog?.match(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/m);
  const latestVersion = versionMatch?.[1];
  check(
    checks,
    'changelog_version_header',
    Boolean(latestVersion),
    'CHANGELOG.md must have a versioned release header with an ISO date',
  );

  let manifest = null;
  try {
    manifest = yaml.load(readFile(rootDir, 'docs/delivery/release-manifest.yaml') || '{}');
  } catch (error) {
    check(checks, 'release_manifest_parse', false, `YAML parse error: ${error.message}`);
  }
  check(
    checks,
    'release_manifest_parse',
    Boolean(manifest && typeof manifest === 'object'),
    'docs/delivery/release-manifest.yaml must parse as YAML',
  );

  const manifestVersion = manifest?.release;
  check(
    checks,
    'release_manifest_matches_changelog',
    Boolean(latestVersion && manifestVersion && latestVersion === manifestVersion),
    `changelog=${latestVersion ?? 'missing'}, release-manifest=${manifestVersion ?? 'missing'}`,
  );

  const checksums = manifest?.bundle?.checksums;
  const checksumsPath = checksums ? path.join(rootDir, checksums) : null;
  const checksumsOk = Boolean(
    checksumsPath &&
      fs.existsSync(checksumsPath) &&
      fs.statSync(checksumsPath).size > 0,
  );
  check(
    checks,
    'release_bundle_checksums',
    checksumsOk,
    checksumsOk
      ? `release bundle checksums OK: ${checksums} (${fs.statSync(checksumsPath).size} bytes)`
      : `release bundle checksums missing or empty: ${checksums ?? 'not declared'}`,
  );

  const taskBoard = readFile(rootDir, '.codex/artifacts/task-board.md');
  const rows = parseTaskBoardRows(taskBoard);
  const rowsWithoutEvidence = rows.filter((row) => !row.evidence);
  check(
    checks,
    'task_board_rows_have_evidence',
    rows.length > 0 && rowsWithoutEvidence.length === 0,
    `${rowsWithoutEvidence.length}/${rows.length} task-board rows are missing evidence`,
  );

  const gates = readFile(rootDir, '.codex/artifacts/gates.md');
  const missingGates = Array.from({ length: 14 }, (_, index) => `G${index}`).filter(
    (gate) => !gates?.includes(`| ${gate} |`),
  );
  check(
    checks,
    'gates_cover_g0_g13',
    missingGates.length === 0,
    `gates.md missing: ${missingGates.join(', ')}`,
  );

  const phaseState = readFile(rootDir, '.codex/artifacts/phase-state.md');
  let stateJson = null;
  try {
    stateJson = JSON.parse(readFile(rootDir, '.codex/artifacts/state.json') || 'null');
  } catch {
    stateJson = null;
  }
  const traceId = stateJson?.trace_id;
  check(
    checks,
    'phase_state_trace_matches_state',
    Boolean(traceId && phaseState?.includes(traceId)),
    'phase-state.md must reference the same trace_id as state.json',
  );

  const routeManifestPath = path.join(rootDir, 'openapi/route-manifest.json');
  let routeManifest = null;
  try {
    routeManifest = JSON.parse(readFile(rootDir, 'openapi/route-manifest.json') || 'null');
  } catch {
    routeManifest = null;
  }
  const fresh = freshRouteAudit(rootDir);
  const routeManifestCurrent =
    Boolean(routeManifest) &&
    arraysEqual(routeManifest.controllerKeys, fresh.controllerKeys) &&
    arraysEqual(routeManifest.specKeys, fresh.specKeys) &&
    routeManifest.controllerOperations === fresh.result.controllerOperations &&
    routeManifest.specOperations === fresh.result.specOperations &&
    routeManifest.documentedControllerOperations ===
      fresh.result.documentedControllerOperations &&
    (routeManifest.undocumented || []).length === fresh.result.undocumented.length &&
    (routeManifest.unimplemented || []).length === fresh.result.unimplemented.length;
  check(
    checks,
    'route_manifest_current',
    routeManifestCurrent,
    `manifest=${routeManifest?.controllerOperations ?? 'missing'}/${routeManifest?.specOperations ?? 'missing'}, ` +
      `live=${fresh.result.controllerOperations}/${fresh.result.specOperations}; regenerate with ` +
      'node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json',
  );

  const sharedApi =
    readFile(rootDir, 'ewoh-spark-app/shared/api.interface.ts') ||
    readFile(rootDir, 'shared/api.interface.ts');
  const missingDataSources = REQUIRED_DATA_SOURCES.filter(
    (source) => !sharedApi?.includes(`'${source}'`),
  );
  check(
    checks,
    'data_source_vocabulary',
    missingDataSources.length === 0,
    `DataSourceType missing: ${missingDataSources.join(', ')}`,
  );

  const errorInterface = readFile(
    rootDir,
    'ewoh-spark-app/server/common/interfaces/api_response.interface.ts',
  );
  const missingErrorFields = REQUIRED_ERROR_FIELDS.filter(
    (field) => !errorInterface?.includes(field),
  );
  check(
    checks,
    'error_contract_fields',
    missingErrorFields.length === 0,
    `ApiErrorResponse missing: ${missingErrorFields.join(', ')}`,
  );

  return checks;
}

function check(checks, name, ok, detail) {
  checks.push({ name, ok, detail });
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const json = args.includes('--json');
  const checks = auditRepoFacts(root);
  const failed = checks.filter((entry) => !entry.ok);

  if (json) {
    console.log(
      JSON.stringify(
        { root, passed: checks.length - failed.length, failed: failed.length, checks },
        null,
        2,
      ),
    );
  } else {
    console.log(`REPO FACTS AUDIT: ${checks.length - failed.length}/${checks.length} passed`);
    for (const entry of failed) {
      console.log(`  FAIL ${entry.name}: ${entry.detail}`);
    }
  }

  if (strict && failed.length > 0) {
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
  auditRepoFacts,
};
