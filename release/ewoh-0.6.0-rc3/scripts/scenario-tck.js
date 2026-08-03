#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const gates = [
  ['scripts/audit-golden-factory.js', []],
  ['scripts/audit-policy-contracts.js', []],
  ['scripts/audit-workflow-contracts.js', []],
  ['scripts/audit-mapping-contracts.js', []],
  ['scripts/audit-event-catalog.js', []],
  ['scripts/audit-work-graph-contracts.js', []],
  ['scripts/audit-asset-catalog-contracts.js', []],
  ['scripts/audit-factory-profile-contracts.js', []],
];

const failures = [];
for (const [script, args] of gates) {
  try {
    execFileSync(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: 'inherit',
      encoding: 'utf8',
    });
  } catch (error) {
    failures.push(script);
  }
}

if (failures.length > 0) {
  console.error(`SCENARIO TCK FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`SCENARIO TCK PASSED (${gates.length} gates)`);
}
