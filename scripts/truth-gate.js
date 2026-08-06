#!/usr/bin/env node
'use strict';

/**
 * truth-gate — release drift gate (machine-verifiable Production Ready).
 *
 * Given a current build SHA and an evidence manifest, fails (non-zero) whenever
 * the manifest CLAIMS Production Ready while the constraint set is not met:
 *   - any mandatory gate is not SUCCEEDED (NOT_RUN/FAILED/BLOCKED_BY_ENVIRONMENT),
 *   - the evidence SHA != current SHA (STALE).
 *
 * Production Ready is never trusted from the manifest verbatim; it is
 * recomputed from the manifest's own gate results + the current SHA.
 *
 * Usage:
 *   node scripts/truth-gate.js [--manifest <path>] [--sha <currentSha>]
 *   --manifest  default output/evidence-manifest.json
 *   --sha       current commit SHA; default GITHUB_SHA || `git rev-parse HEAD`
 */

const fs = require('node:fs');
const path = require('node:path');
const { gitHead } = require('./truth-source');
const { computeProductionReady } = require('./truth-status');

const root = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(root, 'output', 'evidence-manifest.json');

function currentShaFromArgs(args) {
  const i = args.indexOf('--sha');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env.GITHUB_SHA || gitHead();
}

function main() {
  const args = process.argv.slice(2);
  const manifestArgIndex = args.indexOf('--manifest');
  const manifestPath = manifestArgIndex >= 0
    ? path.resolve(root, args[manifestArgIndex + 1])
    : DEFAULT_MANIFEST;
  const sha = currentShaFromArgs(args);

  if (!fs.existsSync(manifestPath)) {
    console.error(`TRUTH-GATE: no manifest at ${manifestPath}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const computed = computeProductionReady(manifest, sha);
  const claim = manifest.productionReady;

  console.log(`TRUTH-GATE: manifest=${manifestPath}`);
  console.log(`  evaluatedCommitSha=${manifest.evaluatedCommitSha} current=${sha}`);
  console.log(`  manifest.productionReady=${claim} recomputed=${computed.ready} stale=${computed.stale}`);
  for (const reason of computed.reasons) {
    console.log(`  reason: ${reason}`);
  }

  // The manifest CLAIMS Production Ready. It must hold under the recomputed,
  // current-SHA truth. If any mandatory gate is not SUCCEEDED or the evidence
  // is STALE, the claim is a drift -> fail closed.
  if (claim === true && !computed.ready) {
    console.error('TRUTH-GATE BLOCKED: manifest claims Production Ready but constraints are not met:');
    for (const reason of computed.reasons) {
      console.error(`  - ${reason}`);
    }
    process.exit(1);
  }

  if (claim === true && computed.ready) {
    console.log('TRUTH-GATE OK: Production Ready claim holds on current SHA.');
    return;
  }

  // Manifest does NOT claim Production Ready. Nothing to gate; report the
  // recomputed posture so an operator can see WHY it is not ready.
  console.log(
    computed.ready
      ? 'TRUTH-GATE OK: manifest does not claim Production Ready (recomputed ready=true).'
      : 'TRUTH-GATE OK: manifest does not claim Production Ready (recomputed ready=false).',
  );
  return;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = { main };