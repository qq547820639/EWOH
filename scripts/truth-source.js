#!/usr/bin/env node
'use strict';

/**
 * Single source of truth for volatile repository facts.
 *
 * Version, git HEAD and git branch are DERIVED here at runtime rather than
 * hard-coded into artifacts, so a new commit never invalidates a stale copied
 * SHA and a version bump happens in exactly one place (version.json).
 *
 *   - readVersion() : the authoritative version, from version.json at repo root
 *   - gitHead()     : live `git rev-parse HEAD`
 *   - gitBranch()   : live `git branch --show-current`
 *
 * Consumers (collect-repo-facts.js, audit-repo-facts.js, CI, release tooling)
 * import this module instead of re-deriving or hard-coding these values.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/**
 * Read the authoritative version from version.json.
 * Returns null when the file is missing or unparseable.
 */
function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(root, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === 'string' && parsed.version
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Return the live git HEAD SHA (full 40-hex). Falls back to 'unknown'.
 */
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Return the current git branch name. Falls back to 'unknown'.
 */
function gitBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

module.exports = {
  gitBranch,
  gitHead,
  readVersion,
  root,
};