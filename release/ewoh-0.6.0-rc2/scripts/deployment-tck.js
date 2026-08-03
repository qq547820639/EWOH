#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const steps = [
  { command: process.execPath, script: 'scripts/verify-deploy-artifacts.js', args: [] },
  { command: process.execPath, script: 'scripts/verify-helm-chart.js', args: [] },
  { command: process.execPath, script: 'scripts/scale-release-review.js', args: [] },
  { command: 'python3', script: 'scripts/rego-tck.py', args: [] },
];

const failures = [];
for (const step of steps) {
  try {
    execFileSync(step.command, [path.join(root, step.script), ...step.args], {
      cwd: root,
      stdio: 'inherit',
      encoding: 'utf8',
    });
  } catch (error) {
    failures.push(step.script);
  }
}

if (failures.length > 0) {
  console.error(`DEPLOYMENT TCK FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`DEPLOYMENT TCK PASSED (${steps.length} gates)`);
}
