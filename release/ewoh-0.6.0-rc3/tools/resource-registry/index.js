#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const workIndexer = require('../work-indexer/index.js');

function parseArgs(argv) {
  const options = { root: process.cwd(), output: null, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--output') {
      options.output = argv[++index];
    } else if (argument === '--strict') {
      options.strict = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function readLocks(artifactsDir) {
  const lockDir = path.join(artifactsDir, 'work', 'locks');
  const locks = [];
  if (!fs.existsSync(lockDir)) return locks;
  for (const entry of fs.readdirSync(lockDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(lockDir, entry), 'utf8'));
      locks.push({ ...lock, source: `.codex/artifacts/work/locks/${entry}` });
    } catch {
      // skip malformed lock files
    }
  }
  return locks;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = workIndexer.indexWorkGraph(artifactsDir, { root: options.root });
  const locks = readLocks(artifactsDir);
  const resources = (graph.resources || []).map((resource) => {
    const lock = locks.find(
      (entry) => entry.resourceId === resource.resourceId && entry.active !== false,
    );
    return {
      ...resource,
      lock: lock
        ? {
            holder: lock.holder,
            purpose: lock.purpose,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
          }
        : null,
    };
  });
  const result = {
    generatedAt: new Date().toISOString(),
    resourceCount: resources.length,
    lockedCount: resources.filter((resource) => resource.lock).length,
    resources,
    locks,
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(`Resource registry written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Resource registry: ${result.resourceCount} resources | ${result.lockedCount} locked`,
  );
  if (options.strict && resources.some((resource) => resource.status === 'missing')) {
    process.exitCode = 1;
  }
}

module.exports = { readLocks };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
