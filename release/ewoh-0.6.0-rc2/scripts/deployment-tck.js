#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const steps = [
  ['scripts/verify-deploy-artifacts.js', []],
  ['scripts/verify-helm-chart.js', []],
  ['scripts/scale-release-review.js', []],
];

const failures = [];
for (const [script, args] of steps) {
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
  console.error(`DEPLOYMENT TCK FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`DEPLOYMENT TCK PASSED (${steps.length} gates)`);
}
