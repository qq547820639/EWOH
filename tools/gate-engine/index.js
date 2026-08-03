#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const workIndexer = require('../work-indexer/index.js');

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    graph: null,
    output: null,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--graph') {
      options.graph = argv[++index];
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

function loadHumanDecisions(artifactsDir) {
  const file = path.join(artifactsDir, 'work', 'gate-decisions.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function calculate(gates, humanDecisions, artifactsDir) {
  const decisions = new Map(
    humanDecisions.map((entry) => [entry.gateId, entry]),
  );
  return gates.map((gate) => {
    const human = decisions.get(gate.gateId) || null;
    const base = gate.calculatedStatus || 'pending';
    let finalStatus = base;
    if (human?.decision === 'approved') {
      finalStatus = 'approved';
    } else if (human?.decision === 'rejected') {
      finalStatus = 'rejected';
    } else if (human?.decision === 'conditional') {
      finalStatus = 'conditional';
    } else if (
      base === 'passed' &&
      (Number(gate.gateId.replace(/[^0-9]/g, '')) >= 10 ||
        /production|acceptance|closeout/i.test(gate.title))
    ) {
      finalStatus = 'requires_approval';
    }
    return {
      gateId: gate.gateId,
      title: gate.title,
      calculatedStatus: finalStatus,
      baseStatus: base,
      humanDecision: human?.decision ?? null,
      approver: human?.approver ?? null,
      decidedAt: human?.decidedAt ?? null,
      conditions: gate.conditions || [],
      evidenceCount: gate.evidenceCount ?? 0,
    };
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = options.graph
    ? JSON.parse(fs.readFileSync(path.resolve(options.graph), 'utf8'))
    : workIndexer.indexWorkGraph(artifactsDir, { root: options.root });
  const humanDecisions = loadHumanDecisions(artifactsDir);
  const gates = calculate(graph.gates || [], humanDecisions, artifactsDir);
  const pending = gates.filter((gate) => gate.calculatedStatus === 'requires_approval');
  const result = {
    generatedAt: new Date().toISOString(),
    gateCount: gates.length,
    approvedCount: gates.filter((gate) => gate.calculatedStatus === 'approved').length,
    requiresApprovalCount: pending.length,
    gates,
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(`Gate decisions written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Gate engine: ${result.gateCount} gates | ${result.approvedCount} approved | ` +
      `${result.requiresApprovalCount} require human approval`,
  );
  for (const gate of pending) {
    console.log(`  approval required: ${gate.gateId} ${gate.title}`);
  }
  if (options.strict && result.requiresApprovalCount > 0) {
    process.exitCode = 2;
  }
}

module.exports = { calculate };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
