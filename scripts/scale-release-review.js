#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const version = process.env.EWOH_RELEASE_VERSION || '0.6.0-rc2';
const bundleDir = path.join(root, 'release', `ewoh-${version}`);
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');

const checks = [];
const push = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
};

const exists = (file) => fs.existsSync(path.join(root, file));

function runScript(script, args = []) {
  try {
    execFileSync(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return true;
  } catch (error) {
    const output = String(error?.stdout || error?.stderr || error?.message || '');
    return { ok: false, output: output.split('\n').slice(-3).join('\n') };
  }
}

const releaseManifestPath = path.join(root, 'docs/delivery/release-manifest.yaml');
try {
  const manifest = yaml.load(fs.readFileSync(releaseManifestPath, 'utf8'));
  push(
    'release-manifest',
    manifest.release === version && String(manifest.status).includes('candidate'),
    `release=${manifest.release} status=${manifest.status}`,
  );
} catch (error) {
  push('release-manifest', false, String(error.message));
}

push('bundle-directory', fs.existsSync(bundleDir), bundleDir);
const checksumPath = path.join(bundleDir, 'SHA256SUMS.txt');
push('bundle-checksums', fs.existsSync(checksumPath));
if (fs.existsSync(bundleDir)) {
  const files = fs.readdirSync(bundleDir, { recursive: true }).length;
  push('bundle-file-count', files > 500, `${files} files`);
  const envFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === '.env' || entry.name === '.env.local') {
        envFiles.push(full);
      }
    }
  };
  walk(bundleDir);
  push('bundle-no-real-env', envFiles.length === 0, envFiles.join(', '));
}

try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'openapi/route-manifest.json'), 'utf8'),
  );
  push(
    'openapi-route-manifest',
    manifest.documentedControllerOperations >= 166 &&
      manifest.undocumented.length === 0 &&
      manifest.unimplemented.length === 0,
    `${manifest.documentedControllerOperations} documented / 0 undocumented / 0 unimplemented`,
  );
} catch (error) {
  push('openapi-route-manifest', false, String(error.message));
}

const requiredContracts = [
  'contracts/events/event-catalog.yaml',
  'contracts/factory/golden-factory.yaml',
  'contracts/mapping/mapping-schema.json',
  'contracts/policy/policy-schema.json',
  'contracts/state-machines/fleet.yaml',
  'deploy/cloud/helm/ewoh/Chart.yaml',
];
for (const contract of requiredContracts) {
  push(`contract-${path.basename(contract)}`, exists(contract), contract);
}

const requiredDocs = [
  'docs/delivery/acceptance-evidence.md',
  'docs/delivery/training-plan.md',
  'docs/delivery/deployment-runbook.md',
  'docs/delivery/release-checklist.md',
];
for (const doc of requiredDocs) {
  push(`doc-${path.basename(doc)}`, exists(doc), doc);
}

const scriptChecks = [
  ['scripts/audit-openapi-routes.js', ['--strict']],
  ['scripts/audit-event-catalog.js', []],
  ['scripts/audit-golden-factory.js', []],
  ['scripts/audit-mapping-contracts.js', []],
  ['scripts/audit-policy-contracts.js', []],
  ['scripts/verify-helm-chart.js', []],
  ['scripts/verify-deploy-artifacts.js', []],
];
for (const [script, args] of scriptChecks) {
  const result = runScript(script, args);
  if (result === true) {
    push(`script-${path.basename(script)}`, true);
  } else {
    push(
      `script-${path.basename(script)}`,
      false,
      result.output || 'command failed',
    );
  }
}

const passed = checks.filter((check) => check.passed).length;
const failed = checks.filter((check) => !check.passed).length;
console.log(
  JSON.stringify(
    {
      release: version,
      reviewedAt: new Date().toISOString(),
      passed,
      failed,
      overall: failed === 0 ? 'PASSED' : 'FAILED',
      checks,
    },
    null,
    2,
  ),
);
if (failed > 0) {
  process.exitCode = 1;
}
