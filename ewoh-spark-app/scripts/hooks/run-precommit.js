#!/usr/bin/env node
// FULLSTACK_PRECOMMIT_V1
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SEP = '  ' + '─'.repeat(36);

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function failAndExit(step, body) {
  process.stderr.write('\n✗ pre-commit failed: ' + step + '\n');
  process.stderr.write(SEP + '\n');
  if (body && body.length > 0) {
    process.stderr.write(body.replace(/\s+$/, '') + '\n');
  }
  process.stderr.write(SEP + '\n');
  process.stderr.write('  bypass: git commit --no-verify\n');
  process.exit(1);
}

function runLint() {
  const cwd = process.cwd();
  const res = spawnSync('npm', ['run', 'lint'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (res.error) {
    failAndExit('lint', String(res.error.message || res.error));
  }
  if (res.status !== 0) {
    const stdout = res.stdout ? res.stdout.toString() : '';
    const stderr = res.stderr ? res.stderr.toString() : '';
    failAndExit('lint', stdout + '\n' + stderr);
  }
}

function runReconcile() {
  const res = spawnSync('node', ['scripts/reconcile-authoritative-artifacts.js', '--strict', '--root', REPO_ROOT], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (res.error) {
    failAndExit('reconcile-authoritative-artifacts', String(res.error.message || res.error));
  }
  const stdout = res.stdout ? res.stdout.toString() : '';
  const stderr = res.stderr ? res.stderr.toString() : '';
  if (res.status !== 0) {
    failAndExit('reconcile-authoritative-artifacts', stdout + '\n' + stderr);
  }
}

runLint();
runReconcile();
