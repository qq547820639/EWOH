#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FILES, EXECUTE_COMMANDS } = require('./run_migrations.js');

const root = path.resolve(__dirname, '../..');
const dependencies = { '008': ['017'] };

function migrationChain(files = FILES, commands = EXECUTE_COMMANDS) {
  const migrations = Object.entries(files).flatMap(([key, file]) => {
    const match = /^standalone_(\d+)_.*(?<!\.rollback)\.sql$/.exec(path.basename(file));
    if (!match || path.dirname(file) !== path.join(root, 'db/migrations')) return [];
    const suffix = key.replaceAll('_', '-');
    const migration = {
      id: match[1],
      file,
      apply: `--apply-${suffix}`,
      verify: `--verify-${suffix}`,
      rollback: `--rollback-${suffix}`,
    };
    for (const action of ['apply', 'verify', 'rollback']) {
      if (!commands.has(migration[action])) {
        throw new Error(`Unregistered ${action} command for ${path.basename(file)}`);
      }
    }
    if (files[`${key}_rollback`] !== file.replace(/\.sql$/, '.rollback.sql')) {
      throw new Error(`Missing rollback registration for ${path.basename(file)}`);
    }
    return [migration];
  }).sort((left, right) => Number(left.id) - Number(right.id));
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  if (byId.size !== migrations.length) throw new Error('Duplicate standalone migration ID');
  const diskFiles = fs.readdirSync(path.join(root, 'db/migrations'))
    .filter((file) => /^standalone_\d+_.*\.sql$/.test(file) && !file.endsWith('.rollback.sql'));
  const registeredFiles = new Set(migrations.map((migration) => path.basename(migration.file)));
  if (diskFiles.length !== registeredFiles.size || diskFiles.some((file) => !registeredFiles.has(file))) {
    throw new Error('Standalone migration files and runner registrations do not match');
  }
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cyclic standalone migration dependency: ${id}`);
    if (!byId.has(id)) throw new Error(`Missing standalone migration dependency: ${id}`);
    visiting.add(id);
    for (const dependency of dependencies[id] || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id));
  }
  for (const migration of migrations) visit(migration.id);
  return ordered;
}

function runChain(action) {
  if (!['apply', 'verify', 'rollback', 'plan'].includes(action)) {
    throw new Error('Usage: standalone-chain.js --apply | --verify | --rollback | --plan');
  }
  const chain = migrationChain();
  if (action === 'plan') {
    console.log(JSON.stringify(chain.map(({ file, ...migration }) => ({
      ...migration,
      file: path.relative(root, file),
    })), null, 2));
    return;
  }
  if (action !== 'verify' && process.env.EWOH_ALLOW_DDL !== '1') {
    throw new Error('EWOH_ALLOW_DDL=1 is required for apply and rollback');
  }
  if (action === 'rollback' && process.env.EWOH_ALLOW_DESTRUCTIVE_ROLLBACK !== '1') {
    throw new Error('EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1 is required for destructive rollback');
  }
  const ordered = action === 'rollback' ? [...chain].reverse() : chain;
  for (const migration of ordered) {
    console.log(`[standalone-chain] ${action} ${migration.id}: ${path.basename(migration.file)}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'run_migrations.js'), migration[action]], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${migration[action]} failed (${result.signal || result.status})`);
    }
  }
  console.log(`[standalone-chain] ${action} complete: ${ordered.length} migrations`);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Specify exactly one chain action');
    runChain(process.argv[2].replace(/^--/, ''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { migrationChain, runChain };
