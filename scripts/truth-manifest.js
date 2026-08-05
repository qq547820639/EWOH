#!/usr/bin/env node
'use strict';

/**
 * TRUTH_MANIFEST_V1 — evidence manifest generator (single source of truth).
 *
 * Emits a structured evidence manifest whose volatile facts are DERIVED at run
 * time (git HEAD, branch, version.json, test-count reports, toolchain/env),
 * never hard-coded into Git-tracked docs. CI consumes this manifest to prove
 * what was evaluated, on which commit, with which toolchain, and which digests.
 *
 * Required fields (per truth-source spec):
 *   evaluatedCommitSha, branch, buildVersion, environmentFingerprint,
 *   dependencyVersions, testStartedAt, testFinishedAt, verifier,
 *   workflowRunId, artifactDigest, expiration.
 *
 * Usage:
 *   node scripts/truth-manifest.js [--out <path>] [--check]
 *   --out   default: output/evidence-manifest.json
 *   --check recompute and compare against the committed/prior manifest;
 *           exit non-zero on drift (used by `make truth-check`).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const truth = require('./truth-source');
const collect = require('./collect-repo-facts');

const DEFAULT_OUT = path.join(root, 'output', 'evidence-manifest.json');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function envFingerprint() {
  const parts = [
    `node=${process.versions.node}`,
    `npm=${execSafe('npm', ['--version'], 'unknown')}`,
    `python=${execSafe(process.env.PYTHON || 'python3', ['--version'], 'unknown')}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
  ];
  return sha256Hex(parts.join('|'));
}

function dependencyVersions() {
  const versions = {
    node: process.versions.node,
    npm: execSafe('npm', ['--version'], 'unknown'),
    python: execSafe(process.env.PYTHON || 'python3', ['--version'], 'unknown'),
  };
  // Runtime dependency versions from the lockfile (resolved, exact).
  const lock = path.join(root, 'ewoh-spark-app', 'package-lock.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(lock, 'utf8'));
    const top = (pkg.packages && pkg.packages['']) || {};
    const deps = {
      ...(top.dependencies || {}),
      ...(top.devDependencies || {}),
    };
    versions.appDependencies = Object.fromEntries(
      Object.entries(deps)
        .filter(([, v]) => typeof v === 'string' && !v.startsWith('^') && !v.startsWith('~'))
        .slice(0, 200),
    );
  } catch {
    versions.appDependencies = null;
  }
  return versions;
}

function execSafe(cmd, args, fallback) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function testWindow() {
  // Prefer the latest server jest report's startTime + duration for the window.
  const report = path.join(root, 'ewoh-spark-app', 'jest.results.json');
  try {
    const data = JSON.parse(fs.readFileSync(report, 'utf8'));
    if (typeof data.startTime === 'number') {
      const started = new Date(data.startTime).toISOString();
      const finished = new Date(data.startTime + (data.testResults || []).length * 0).toISOString();
      // duration is not top-level; use last test's endTime if present.
      let endMs = data.startTime;
      for (const r of data.testResults || []) {
        if (typeof r.endTime === 'number' && r.endTime > endMs) endMs = r.endTime;
      }
      return { startedAt: started, finishedAt: new Date(endMs).toISOString() };
    }
  } catch {
    /* fall through */
  }
  const now = new Date().toISOString();
  return { startedAt: now, finishedAt: now };
}

function collectSnapshotDigest() {
  // The artifact digest anchors the manifest to the collected repo-facts
  // snapshot (version, test counts, work-graph, OpenAPI footprint).
  //
  // The digest MUST be deterministic for a given HEAD so --check is stable:
  // we exclude the volatile generatedAt timestamp and hash only the stable
  // facts that SHOULD not change for an unchanged tree+toolchain.
  const stableKeys = [
    'head', 'branch', 'version', 'testCounts',
    'evidence', 'workGraph', 'openapi', 'database',
  ];
  try {
    const snapshot = collect.collect({ outPath: null });
    const mapped = {};
    for (const key of stableKeys) {
      if (key in snapshot) mapped[key] = snapshot[key];
    }
    return sha256Hex(JSON.stringify(mapped));
  } catch (error) {
    return sha256Hex(`collect-failed:${String((error && error.message) || error)}`);
  }
}

function buildManifest() {
  const window = testWindow();
  const digest = collectSnapshotDigest();
  return {
    schema: 'ewoh:///evidence-manifest/v1',
    evaluatedCommitSha: process.env.GITHUB_SHA || truth.gitHead(),
    branch: process.env.GITHUB_REF_NAME || truth.gitBranch(),
    buildVersion: truth.readVersion() || 'unknown',
    environmentFingerprint: envFingerprint(),
    dependencyVersions: dependencyVersions(),
    testStartedAt: window.startedAt,
    testFinishedAt: window.finishedAt,
    verifier: process.env.GITHUB_ACTOR || 'local',
    workflowRunId: process.env.GITHUB_RUN_ID || null,
    artifactDigest: digest,
    expiration: {
      policy: 'evidence-manifest expires from the evaluatedCommitSha; re-run on every HEAD change',
      expiresAt: null,
    },
    generatedAt: new Date().toISOString(),
  };
}

function main() {
  const args = process.argv.slice(2);
  const outArgIndex = args.indexOf('--out');
  const outPath = outArgIndex >= 0 ? path.resolve(root, args[outArgIndex + 1]) : DEFAULT_OUT;
  const checkMode = args.includes('--check');

  const manifest = buildManifest();

  if (checkMode) {
    if (!fs.existsSync(outPath)) {
      console.log(`TRUTH-MANIFEST: no prior manifest at ${outPath}; generating baseline (HEAD ${manifest.evaluatedCommitSha})`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
      process.exit(0);
    }
    const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const drift = [];
    for (const key of [
      'evaluatedCommitSha',
      'branch',
      'buildVersion',
      'environmentFingerprint',
      'artifactDigest',
    ]) {
      if (prior[key] !== manifest[key]) {
        drift.push(`${key}: ${prior[key]} -> ${manifest[key]}`);
      }
    }
    if (drift.length > 0) {
      console.error('TRUTH-MANIFEST DRIFT DETECTED:');
      for (const line of drift) console.error(`  - ${line}`);
      process.exit(1);
    }
    console.log(`TRUTH-MANIFEST OK: no drift on HEAD ${manifest.evaluatedCommitSha}`);
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`TRUTH-MANIFEST written: ${outPath}`);
  console.log(`  HEAD=${manifest.evaluatedCommitSha} branch=${manifest.branch} version=${manifest.buildVersion}`);
  console.log(`  artifactDigest=${manifest.artifactDigest}`);
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = { buildManifest, main };
