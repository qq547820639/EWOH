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

// TOOL-015: 提取 parseHandoffs 供复用（原 module.exports 为空对象）。
function parseHandoffs(handoffs) {
  const list = Array.isArray(handoffs) ? handoffs : [];
  const open = list.filter((handoff) => handoff.status === 'open');
  return {
    handoffCount: list.length,
    openCount: open.length,
    open,
    handoffs: list,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = workIndexer.indexWorkGraph(artifactsDir, { root: options.root });
  const parsed = parseHandoffs(graph.handoffs);
  const result = {
    generatedAt: new Date().toISOString(),
    handoffCount: parsed.handoffCount,
    openCount: parsed.openCount,
    handoffs: parsed.handoffs,
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(`Handoff registry written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Handoff service: ${result.handoffCount} handoffs | ${result.openCount} open`,
  );
  if (options.strict && parsed.openCount > 0) {
    process.exitCode = 1;
  }
}

module.exports = { parseHandoffs };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
