#!/usr/bin/env node
'use strict';

/**
 * truth-gate-record — write ONE gate result into output/gate-results/<id>.json.
 *
 * CI steps (e.g. the Trivy image scan in security.yml) call this to record a
 * machine-readable status instead of silently treating an environment constraint
 * as success. truth-manifest aggregates these files into the evidence manifest
 * and auto-computes Production Ready from them.
 *
 * Usage:
 *   node scripts/truth-gate-record.js \
 *     --id <gateId> [--name <name>] --status <STATUS> [--details <text>] \
 *     [--out <dir>] [--sha <commitSha>]
 *
 * --status must be one of NOT_RUN | FAILED | BLOCKED_BY_ENVIRONMENT | SUCCEEDED.
 */

const fs = require('node:fs');
const path = require('node:path');
const { gitHead } = require('./truth-source');
const { parseStatus } = require('./truth-status');

const root = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(root, 'output', 'gate-results');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--id') args.id = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--details') args.details = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--sha') args.sha = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error('truth-gate-record: --id is required');
    process.exit(2);
  }
  const status = parseStatus(args.status);
  if (!status) {
    console.error(
      `truth-gate-record: --status must be one of ${JSON.stringify(require('./truth-status').VALID_STATUSES)}`,
    );
    process.exit(2);
  }

  const dir = path.resolve(root, args.out || DEFAULT_DIR);
  const record = {
    id: args.id,
    name: args.name || args.id,
    status,
    details: args.details || '',
    checkedAt: new Date().toISOString(),
    commitSha: args.sha || process.env.GITHUB_SHA || gitHead(),
  };

  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${args.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`TRUTH-GATE-RECORD written: ${outPath} (${status})`);
  return record;
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